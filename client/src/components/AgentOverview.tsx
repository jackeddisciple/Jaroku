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

import { useEffect, useMemo, useRef, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { AgentTagRow } from "./AgentTagRow.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { PencilIcon } from "./panelIcons.tsx";
import { ChevronDownIcon } from "./panelIcons.tsx";
import { AvatarPicker, avatarUsage } from "./AvatarPicker.tsx";
import { AVATAR_SIZE, GlossAvatar, GlossStageProvider } from "./GlossAvatar.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { AGENT_CATEGORIES, normalizeCategory, showsCategory } from "../lib/agentCategories.ts";
import { sendSetAgentAvatar, sendSetAgentCategory, sendSetAgentEmoji } from "../lib/socket.ts";
import { sendRenameAgent } from "../lib/socket.ts";
import { fmtCost, relTime } from "../lib/format.ts";
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
  // WHO ELSE WEARS WHAT, so the picker can say "already worn by X" before somebody chooses it —
  // §8.5's warning. Off the agent list the sidebar is already built from, so it costs no request,
  // and this agent's own mark is excluded because it is not a collision with itself.
  const agents = useBuildStore((s) => s.agents);
  /** §6's "name your own", for an agent that already exists. Cleared once it has been sent. */
  const [customCategory, setCustomCategory] = useState("");

  /**
   * Which agents wear each avatar, with THIS one left out of its own warning.
   *
   * "Also used by itself" is not a warning, and it would appear the moment somebody opened the
   * picker on an agent that already has an avatar — which is every agent.
   */
  const avatarUsedBy = useMemo(() => avatarUsage(agents, a.name), [agents, a.name]);

  const takenBy = useMemo(() => {
    const out = new Map<string, string>();
    for (const other of agents) {
      if (other.agent_id !== a.slug && other.emoji) out.set(other.emoji, other.name);
    }
    return out;
  }, [agents, a.slug]);
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
    // ONE STAGE FOR THE WHOLE HEADER, so the character beside the name and the twenty-eight tiles in
    // the identity picker share a context rather than opening two. `active` is unconditional: this
    // header only exists while the agent detail is on screen, and the loop parks itself on blur and
    // under reduced motion regardless.
    <GlossStageProvider active className="relative isolate shrink-0">
    {/* The header is this character's gaze region too, so it follows the pointer while somebody is
        reading the agent it belongs to — the same behaviour the card has, on the other 3D surface. */}
    <div className="border-b border-hair" data-gloss-gaze>
      {/* THE GRADIENT BAND IS GONE, AND D6 IS WHAT RETIRED IT. That decision recorded a live
          consequence on exactly this surface: the band above said "the blue one" and the mark beside
          the name said "the tractor", two facts about one agent that do not reinforce each other —
          "recorded rather than solved: the fix, if it turns out to matter in use, is to retire the
          gradient, never to put a box around the emoji". It matters now, because a third identity
          arrived. The character IS the agent's face; a generated gradient above it is a second
          picture of the same agent that agrees with nothing.

          Nothing else used the band, and `artFor` is still what the thumbnail path uses elsewhere. */}
      <div className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          {/* §I4'S SECOND SURFACE, and the only other one that draws 3D: "the avatar renders in the
              Agents grid card and the agent detail header." Larger than the card's identity mark
              because there is room to look at it here, and still beside the name rather than above
              it — the name is the primary element on this header exactly as it is on the card. */}
          {!renaming && (
            <GlossAvatar
              agentKey={`detail:${a.slug}`}
              avatarId={a.avatar_id}
              emoji={a.emoji}
              size={AVATAR_SIZE.header}
              className="-mt-0.5"
            />
          )}
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
                className="w-full rounded-control border border-edge bg-panel px-2 py-1 text-label text-ink outline-none focus-visible:shadow-focusring"
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
              <Chip size="sm" tone="faint" title="The version currently live">
                v{a.current_version}
              </Chip>
              {/* §6'S CATEGORY, WHERE THE OTHER TWO IDENTIFIERS ARE. `Uncategorized` is left out on
                  the same rule §7 gives the sidebar: an agent nobody has categorised should read as
                  a name, not as a name and a placeholder. The control that SETS it is in the
                  identity section below, with the emoji and the avatar. */}
              {showsCategory(a.category) && (
                <Chip size="sm" tone="faint" title="What this agent is for">
                  {a.category}
                </Chip>
              )}
            </div>
          </div>
        </div>

        {/* §6: "All three are editable afterwards from the agent identity section. None is editable
            from the grid." The name is the pencil above; the other two are here, with the mark that
            was already here — one region, three controls, and it is where somebody looks when they
            want to change what an agent looks like.

            BEHIND A DISCLOSURE, CLOSED. The emoji picker alone is fifty-nine cells; a category list
            is twenty-five and an avatar grid is twenty-eight. Open by default that is a hundred and
            twelve controls above the description, the tag row and every fact on the header — a page
            about changing an agent's appearance rather than about the agent. Editing identity is
            something somebody does once; reading the header is what they do every time. */}
        <details className="group/identity rounded-control border border-hair">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-tiny text-muted transition-colors duration-fast hover:text-ink">
            {/* A CHEVRON, NOT A WORD — the app's one disclosure vocabulary. Down when open, ninety
                degrees when closed, as every tree and section here. */}
            <span className="text-faint transition-transform duration-fast group-open/identity:rotate-0 -rotate-90" aria-hidden>
              <ChevronDownIcon size={ICON.xs} />
            </span>
            Identity
            <span className="ml-auto text-faint">mark, category, avatar</span>
          </summary>

          <div className="space-y-3 border-t border-hair p-2.5">
            {/* §8.5'S PICKER, unchanged and first, because it is the mark six of the seven surfaces
                actually show. */}
            <div>
              <span className={TYPE.sectionLabel}>Mark</span>
              <div className="mt-1.5">
                <EmojiPicker
                  current={a.emoji}
                  takenBy={takenBy}
                  onChoose={(e) => sendSetAgentEmoji(a.slug, e)}
                />
              </div>
            </div>

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
                className="mt-1.5 w-full rounded-control border border-edge bg-panel px-2.5 py-1 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
              />
            </div>

            {/* §6'S AVATAR, through the same picker the create dialog uses — one grid, one set of
                tiles, one duplicate warning. This agent is left out of its own warning: "also used
                by itself" is not a warning. */}
            <div>
              <span className={TYPE.sectionLabel}>Avatar</span>
              <div className="mt-1.5">
                <AvatarPicker
                  current={a.avatar_id}
                  usedBy={avatarUsedBy}
                  onChoose={(id) => sendSetAgentAvatar(a.slug, id)}
                  columns={6}
                />
              </div>
            </div>
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
            <span className="shrink-0 text-tiny uppercase tracking-wider text-faint">Recent runs</span>
            <AgentSparkline outcomes={a.outcomes} height={14} />
          </div>
        )}
      </div>
    </div>
    </GlossStageProvider>
  );
}

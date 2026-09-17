// §5's agent card. A glance, not a dashboard: every element below is one line or one badge.
//
// THE SEVEN STATES §5.3 ASKS TO BE BUILT AND LOOKED AT are all reachable from this one component,
// and none of them is a variant of it: never-run, working, failing, deployed, drifted,
// credential-missing and archived are the same card with different facts true of it. That is
// deliberate — a card that switched layout per state would have seven layouts to keep in step, and
// the states co-occur (an archived agent can be drifted; a failing one can be missing a credential).
//
// THE TWO DENSITIES ARE REAL LAYOUTS, NOT A SCALE TRANSFORM (§4). Compact drops the current-work
// subtitle line and shrinks the thumbnail; it does not shrink the type, because the type ladder is
// three sizes and a fourth one produced by `transform: scale` is a fourth size with no name.
//
// STRUCTURE IN HAIRLINES, NOT FILLS (§9). One border, one radius from the size ladder, one elevation
// — and the hover is `shadow-glow` rather than a fill change, because a card that answers the
// pointer by changing colour has spent a surface step to say something a border can say for free.
// The argument used to be narrower than that: on #0d0d0f a card could not get meaningfully darker
// and could only get brighter at its edge. The palette is light now and `shadow-glow` deepens the
// border instead of brightening it, which is the same treatment arriving from the other direction.

import { useState } from "react";
import { DateChip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { AgentTagRow } from "./AgentTagRow.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { FACE_SIZE, AgentFace, AgentBanner } from "./AgentFace.tsx";
import { stateBorder } from "../lib/stateBorder.ts";
import { AlertTriangleIcon, GitForkIcon } from "./panelIcons.tsx";
import { agentContextMarkdown } from "../lib/agentContext.ts";
import { faceFor } from "../lib/agentFaces.ts";
import { showsCategory } from "../lib/agentCategories.ts";
import { absTime, fmtCost } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ProviderMark } from "../lib/icons.tsx";
import { ICON, STATUS } from "../lib/tokens.ts";
import { spendFor, useAgentGridStore } from "../store/agentGridStore.ts";
import type { AgentCardView } from "../types.ts";
import type { AgentDensity } from "../lib/agentFilter.ts";

/** §5.2's footer word, from the bucket the server already resolved. */
const ACTIVITY_LABEL = { quiet: "Quiet", steady: "Steady", high: "High" } as const;

/**
 * How tall the banner is, per density.
 *
 * SET AGAINST THE PORTRAIT RATHER THAN AGAINST THE CARD. The picture straddles the seam, so the band
 * has to be tall enough to hold the three-fifths of it that sits above — 32px of a 56px portrait,
 * plus air above the portrait's own top edge, or the picture reads as hanging off the top of the
 * band rather than resting in it.
 *
 * A NUMBER RATHER THAN A HEIGHT CLASS, because it is the one dimension on this card that the
 * portrait's size dictates. Written as `h-20` it would be a class that has to be changed in step
 * with `FACE_SIZE.card` with nothing to say so; here the two sit in the same file and the comment
 * is between them.
 *
 * COMPACT SHRINKS IT, which is the third thing compact does after dropping the current-work line and
 * shrinking the portrait — and it shrinks in the same proportion as the portrait, so the overlap
 * reads the same at both densities.
 */
const BANNER_HEIGHT = { card: 104, compact: 72 } as const;

/** §5.2's overflow menu: Fork · Rename · Export current version · Archive. */
function Overflow({
  agent,
  onFork,
  onRename,
  onExport,
  onArchive,
  onRestore,
}: {
  agent: AgentCardView;
  onFork: () => void;
  onRename: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const archived = agent.archived_at !== null;

  const item = (
    label: string,
    Icon: (p: { size?: number }) => React.ReactElement,
    onPick: () => void,
    danger = false,
  ) => (
    <button
      key={label}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        onPick();
      }}
      className={`flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption transition-colors duration-fast hover:bg-active active:bg-chrome ${
        danger ? "text-err hover:text-err" : "text-muted hover:text-ink"
      }`}
    >
      <Icon size={ICON.xs} />
      {label}
    </button>
  );

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        // §8: every icon-only control gets an accessible label and a tooltip. An icon nobody can name
        // is a worse button than a text button.
        title="More actions"
        aria-label={`More actions for ${agent.name}`}
        aria-expanded={open}
        className="rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
      >
        <Icon.agents.more size={ICON.sm} />
      </button>
      {open && (
        <>
          {/* A full-screen catcher rather than a document listener: it closes on any click outside,
              including one that would otherwise open a different card, and it disappears with the
              menu rather than outliving it. */}
          <div className="fixed inset-0 z-30" aria-hidden onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 top-full z-30 mt-1 w-52 animate-slide-in rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none">
            {archived
              ? item("Restore", Icon.agents.restore, onRestore)
              : [
                  item("Fork", GitForkIcon, onFork),
                  item("Rename", Icon.agentDetail.rename, onRename),
                  // EXPORT IS ONLY OFFERED WHEN THERE IS A VERSION TO EXPORT, and the absence of
                  // this check was a control that looked like it worked and did nothing.
                  //
                  // WHAT IT DID. The entry sets a one-shot intent and asks the server for the
                  // agent's current version; `AgentsView` saves the file payload when it arrives.
                  // For an agent with nothing published — every agent the New agent dialog and
                  // onboarding create — `agentVersionFiles` finds no version row and returns
                  // `undefined`, so no payload ever arrives: no download, no error, no message.
                  // Found by pressing it on a draft and watching `URL.createObjectURL` never be
                  // called.
                  //
                  // AND THE INTENT WAS LEFT SET, which is the half that could surprise somebody
                  // later: it clears only when a matching payload lands, so the next time anybody
                  // loaded a version OF THAT AGENT — after building it, from the detail's version
                  // list — the stale intent would fire and download a file nobody asked for.
                  //
                  // REMOVED RATHER THAN DISABLED WITH A TOOLTIP. This codebase's own rule, from the
                  // commit that took out a greyed control with an explanatory tooltip: "a greyed
                  // control with 'only an owner can do this' beside it has decided somebody should
                  // keep looking at it". There is nothing to export yet and nothing to explain.
                  ...(agent.version_source === null
                    ? []
                    : [item("Export current version", Icon.agentDetail.export, onExport)]),
                  // ARCHIVE, AND THERE IS NO DELETE HERE. §5.2 lists both and this product has no
                  // delete path for an agent, deliberately: its versions, runs, traces and costs are
                  // the record every past comparison points at. The confirmation §7.5 asks for —
                  // naming the creator, as the collaborative-workspace safety net — is on this,
                  // because this is the destructive-looking act that actually exists.
                  item("Archive", Icon.threads.archive, onArchive, true),
                ]}
          </div>
        </>
      )}
    </div>
  );
}

export interface AgentCardProps {
  agent: AgentCardView;
  density: AgentDensity;
  /** True while the keyboard cursor is on this card. §5.5: focus must be visible. */
  focused: boolean;
  /** Names, for §5.2's creator initial. Team workspaces only — see `AgentGridSnapshot.team`. */
  creatorInitial: string | null;
  onOpen: () => void;
  onNewThread: () => void;
  onFork: () => void;
  onRename: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRestore: () => void;
}

/**
 * THE CARD'S OWN WORD FOR THE RUNTIME AXIS HAS GONE WITH THE GLYPH IT LABELLED.
 *
 * It existed to title the phase dot before the agent's name — "generating" and "deploying" are both
 * `active` and both amber, so a tooltip saying "running" over a card whose tag says "generating"
 * would be the panel disagreeing with itself. There is no dot now, and the tag row says the word
 * outright instead of hiding it in a tooltip, so there is nothing left for this to caption.
 */

export function AgentCard({
  agent, density, focused, creatorInitial,
  onOpen, onNewThread, onFork, onRename, onExport, onArchive, onRestore,
}: AgentCardProps) {
  const liveSpend = useAgentGridStore((s) => s.liveSpend);
  const [copied, setCopied] = useState(false);
  const compact = density === "compact";
  const spend = spendFor(agent, liveSpend);
  /**
   * Does this agent have a picture at all?
   *
   * THE WHOLE BANNER ARRANGEMENT DEPENDS ON IT AND THE FIRST VERSION DID NOT ASK. With no picture
   * `AgentBanner` renders nothing — correctly — and the sheet's negative margin then pulled it up
   * over the frame's own top padding, while the portrait's `-top-8` hung its fallback initial off
   * the top of the card, where `overflow-hidden` sliced it in half. Two bugs from one assumption,
   * both invisible on any agent created since migration 079 and both waiting on the first row
   * written by an older version mid-deploy.
   *
   * SO THERE ARE TWO LAYOUTS AND THE SECOND ONE IS THE OLD CARD. No band, no overlap, and the
   * initial sits inside the sheet's top right rather than over a seam that is not there.
   */
  const hasFace = faceFor(agent.picture) !== null;
  // THE THREE FACTS §9's LADDER TAKES, read off the card rather than derived twice. `failed` is the
  // HEALTH axis and not the runtime one — D1 keeps them separate, and what a rose edge answers is
  // "is this agent well", which is exactly what the `Failing` tag beside it says in a word.
  const cardState = {
    archived: Boolean(agent.archived_at),
    selected: focused,
    failed: agent.health === "failing",
    running: agent.runtime === "running" || agent.runtime === "generating" || agent.runtime === "deploying",
  };

  const copyContext = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(agentContextMarkdown(agent));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A clipboard that refuses is a browser permission, not a failure worth an error strip —
      // and the tick simply does not appear, which is the honest signal that nothing was copied.
    }
  };

  return (
    <div
      // A DIV WITH A ROLE RATHER THAN A BUTTON, because this card CONTAINS buttons — the sparkline's
      // twenty bars, the overflow menu, `+ New thread` — and a button inside a button is invalid HTML
      // that browsers resolve by dropping one of them.
      role="button"
      tabIndex={-1}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-agent-card={agent.slug}
      aria-label={agent.name}
      // THE HOVER IS A CLASS, NOT AN IMPERATIVE STYLE, and the difference is not tidiness. Writing
      // `element.style.boxShadow` from a pointer handler on an element whose `style` prop React also
      // owns means React wins on the next render — and §5.5's whole promise is that this grid
      // re-renders whenever a broadcast lands, so a hovered card lost its glow every time an
      // unrelated agent's run emitted a step. `shadow-glow` is the same token from `tailwind.config`
      // that `GLOW.hover` is in `tokens.ts`, so nothing about the appearance changes.
      // §11's AGENT CARD, WHICH IS THE ONE ROW OF THAT TABLE THAT MOVED A RUNG. 16px rather than
      // the 12px every other card in the app gets, and §05 is why: "radius follows hierarchy." An
      // agent card is not a standard card that happens to be bigger — it is the primary object of
      // the product's primary surface, and §04 groups it with dialogs and major containers rather
      // than with the Inbox items and thread containers on the rung below. The extra four pixels
      // are the grid saying which of its two card sizes is the one you came here for.
      //
      // §6.1: THE COLOUR MOVES, THE WIDTH DOES NOT. The card keeps `border` — one hairline, the
      // same one at every state — and `stateBorder` recolours it. A `border-2` on a running card
      // would reflow its contents by a pixel every time a run starts, which on a grid that
      // re-renders whenever a broadcast lands is a visible twitch several times a minute.
      //
      // §9's LADDER RESOLVES THE THREE FACTS THIS CARD CAN HOLD AT ONCE. Archived is quiet whatever
      // it used to be doing; then the card you are on; then failing; then running. And the glyph in
      // the title row is EXEMPT — a selected running card has a strong edge and an amber glyph, so
      // "you are here" and "it is running" are both said and neither has to win.
      //
      // ROSE HERE DUPLICATES THE `Failing` TAG DELIBERATELY (§6.2): the colour is the glance and the
      // tag is the word, which is also what keeps I8 true — no border on this card travels alone.
      style={{ borderColor: stateBorder(cardState) }}
      // THREE SURFACES, AND THEY ARE MEANT TO BE TELLABLE APART — the product owner's call. The page
      // is §01's canvas #F6F6F4, this frame is `elevated` #FFFFFF, and the content block inside it is
      // `void` #F0F0EE. Adjacent values were tried first and the card read as one flat shape: frame
      // and block were #FFFFFF and #FAFAF9, one percent apart, which §01 itself warns is "the same
      // surface". Stepping the block DOWN past the page instead makes it read as inset into a white
      // mount, and every value is still one the palette already has.
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-elevated text-left transition-[box-shadow,border-color] duration-fast ${
        focused ? "shadow-glow" : "hover:shadow-glow"
      } ${agent.archived_at ? "opacity-70" : ""}`}
    >
      {/* THE FRAME'S OWN PADDING, AND IT IS THE ONLY THING THIS ELEMENT DOES. Six pixels, the same
          on all four sides, so the banner and the sheet sit inside the card's border rather than
          bleeding to it — which is what turns the card's edge into a mount for the picture instead
          of a crop of it. */}
      <div className="flex min-w-0 flex-1 flex-col p-1.5">
        {/* THE BANNER: the wide band cut from this agent's own portrait, and the reason the top of
            the card now says which agent it is before any text is read. It is the picture's pair
            rather than a generated gradient — D6 retired the gradient band on the detail header for
            exactly this reason, that a generated colour above a picture is a second identity
            agreeing with nothing, and the band here agrees with the face over it because it was cut
            from the same artwork.

            ITS TOP CORNERS FOLLOW THE FRAME AND ITS BOTTOM ONES DO NOT EXIST — the sheet below
            overlaps them. `rounded-t-card` inside the card's `rounded-lg` is the inner rung of the
            same ladder, which is what keeps a radius inside a radius from reading as two.

            NOTHING IS DRAWN WHEN AN AGENT HAS NO PICTURE. `AgentBanner` returns null, the sheet's
            negative margin pulls it against the frame's padding, and the card is its own text on
            its own surface — the state every card was in before this feature. */}
        <AgentBanner
          picture={agent.picture}
          className="shrink-0 rounded-t-card"
          style={{ height: compact ? BANNER_HEIGHT.compact : BANNER_HEIGHT.card }}
        />

        {/* THE SHEET, PULLED UP OVER THE BANNER'S BOTTOM EDGE. The overlap is what the design's one
            structural idea is: the content is a page laid on top of the picture, not a panel under
            it, and the fourteen pixels are what make the sheet's own rounded corners cut into the
            band rather than meet it. `flex-1` so the footer's `mt-auto` still reaches the bottom.

            `relative`, because the portrait is positioned against THIS box rather than the banner.
            The seam is the sheet's top edge, and anchoring the picture to the thing it straddles is
            what keeps the two in step when the banner's height changes with density. */}
        <div
          className={`relative flex min-w-0 flex-1 flex-col rounded-card bg-void ${
            compact ? "gap-1.5 p-2.5" : "gap-2 p-3"
          } ${hasFace ? (compact ? "-mt-3" : "-mt-3.5") : ""}`}
        >
          {/* THE PORTRAIT, OVER THE SEAM, TOP RIGHT. Roughly three-fifths of it above the sheet's
              edge and two-fifths below, which is the proportion that makes it read as resting on the
              card rather than as inset into either half. The ring is the frame's own colour, so what
              separates the picture from the banner behind it is the card showing through.

              IT IS NOT IN THE FLOW, so it costs the sheet no height and the text below starts where
              it always did. What it does cost is the width of the identity block's first two lines,
              which is what the `pr-` below pays for. */}
          <AgentFace
            picture={agent.picture}
            name={agent.name}
            size={compact ? FACE_SIZE.compact : FACE_SIZE.card}
            // THE RING IS THE BANNER'S, NOT THE PICTURE'S. It exists to separate the portrait from
            // the band behind it; with no band there is nothing to separate it from, and a white
            // ring on a #FAFAF9 sheet is a halo round a grey square. `elevated` because that is the
            // colour of the frame this card is — the ring is the card showing through.
            ring={hasFace ? "elevated" : undefined}
            className={
              hasFace
                ? `absolute ${compact ? "-top-6 right-2.5" : "-top-8 right-3"}`
                : `absolute ${compact ? "right-2.5 top-2.5" : "right-3 top-3"}`
            }
          />
          {/* THE HIERARCHY ON THIS CARD IS PICTURE, NAME, SLUG, TAGS, CURRENT WORK, FOOTER, and each
              step down is a real step: a 56px portrait over a banner, 14px of title, 11px of faint
              slug, 10px caps tags, 12px prose, 10px faint figures. The picture is the largest
              element and the name is the next thing the eye lands on, which is the order §5.2 asks
              for — what changed is that the picture is no longer competing for a column beside the
              name and is instead the thing the name is written under.

              THE IDENTITY BLOCK, WHICH IS NOW THE WHOLE LEFT SIDE OF THIS ROW. It was a picture and
              two lines beside it; the picture moved to the seam, so what is left is the two lines —
              and the right padding is the picture's footprint, because a name that ran under a
              portrait would truncate against nothing visible. */}
          <div className={`flex min-w-0 items-start ${compact ? "pr-16" : "pr-20"}`}>
            <div className="min-w-0 flex-1">
            {/* THE PHASE GLYPH IS GONE FROM THIS LINE — the product owner's call. It was a small
                circle before the name answering "what is it doing right now", and D1's separation of
                that from HEALTH is still honoured: the tag row under this says `Running`, `Failing`,
                `Draft`, `Archived` in words. A coloured dot before a name is the kind of mark that
                reads as decoration until somebody explains it, and the words never need explaining.

                WHICH IS ALSO WHAT KEEPS I8 TRUE. "No border travels alone": the card's edge is
                recoloured by `stateBorder`, and what says the same thing in language is the tag row
                — see `test:state-border`, which now looks for it there.

                THE NAME IS THE LOUDEST THING ON THE CARD, at `text-title` — 16px/600 rather than the
                13px/500 of `TYPE.title`, which is a label rung and was never meant to carry the
                primary object of the product's primary surface. The ladder under it is real and each
                step is a step: 16/600 name, 11px faint slug and category, 10px caps tags, 12px prose
                for the current work, 10px faint figures in the footer. */}
            <Truncate className="text-title text-ink" title={agent.name}>
              {agent.name}
            </Truncate>
            {/* The slug at the smaller size — §5.2. It was also in the mono face, on the argument
                that it is an identifier and the prose/code split tells a reader which of the two
                lines they can type. typography.pdf §04 names "agent IDs/slugs" in its Sans list
                explicitly, so what separates the two lines now is size and colour, which is what
                §03 says hierarchy is supposed to come from anyway.

                THE CATEGORY SHARES THE SLUG'S LINE, which is the sidebar's arrangement one surface
                over: the name is the identity and never gives way, and what an agent is FOR sits
                under it with the identifier. Two lines rather than three keeps the card's hierarchy
                at picture, name, then everything else — and the pair reads as one subtitle rather
                than as two competing facts.

                `Uncategorized` IS ABSENT rather than shown, on §7's rule: an agent nobody has
                categorised should read as a name and a slug, not as a name, a slug and a
                placeholder repeated down every card in the grid. */}
            <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
              <Truncate className="min-w-0 text-tiny text-faint" title={agent.slug}>
                {agent.slug}
              </Truncate>
              {showsCategory(agent.category) && (
                <>
                  <span className="shrink-0 text-tiny text-faint" aria-hidden>·</span>
                  <Truncate className="min-w-0 shrink-0 text-tiny text-muted" title={agent.category}>
                    {agent.category}
                  </Truncate>
                </>
              )}
            </div>
            </div>
          </div>

        {/* §5.4's TAG ROW AND THE CARD'S OWN ACTIONS, SHARING A LINE — and the sharing is what the
            portrait's arrival forced. The actions were the top right of the identity row, which is
            where the picture now sits; a control under a portrait is a control nobody can press.

            THIS LINE RATHER THAN THE BANNER, which was the other candidate and is worse on both
            counts that matter: a faint glyph over a saturated band fails contrast at every one of
            the eleven hues, and giving the controls their own scrim to sit on would be the first
            filled container in a product that draws structure in hairlines.

            SO THEY MOVED DOWN ONE ROW AND NOTHING ELSE CHANGED about them. Same cluster, same
            spacing, same held-back weight — the tag row takes the width it needs and the controls
            keep the right end, which is where they have always been. The tags trim to three plus a
            `+n` chip, so there is no width at which the two fight.

            NOT HIDDEN UNTIL HOVER. A control that does not exist until you move the mouse is a
            control nobody finds and nobody can reach on a touch screen — and `focus-within` puts
            them back at full weight for the keyboard, which hover alone would strand. */}
        <div className="flex min-w-0 items-center gap-2">
          <AgentTagRow agent={agent} className="min-w-0 flex-1" />
          <div className="-mr-1 flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
            {/* §5.2'S PRIMARY ACTION IS NOT HERE ANY MORE. It was a bare `+` in this cluster, on the
                argument that three cards across would otherwise mean three outlined bars competing
                with three agent names. The product owner's call is the other way: it is the one
                thing on the card somebody came to DO, and a plus indistinguishable in weight from
                copy-context and the overflow menu is a primary action disguised as a third icon. It
                is a labelled pill at the foot of the card now — see the end of this component. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void copyContext();
              }}
              title={copied ? "Copied" : "Copy this agent's context as markdown"}
              aria-label={`Copy ${agent.name}'s context`}
              className="rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
            >
              <Icon.agentDetail.copy size={ICON.sm} />
            </button>
            <Overflow
              agent={agent}
              onFork={onFork}
              onRename={onRename}
              onExport={onExport}
              onArchive={onArchive}
              onRestore={onRestore}
            />
          </div>
        </div>

        {/* §5.2's current work. Dropped entirely at compact density — that is what makes the two
            densities different layouts rather than one at two scales. */}
        {!compact && (
          <div className="min-w-0">
            {agent.latest_thread ? (
              <>
                <Truncate className="text-caption text-ink" title={agent.latest_thread.title}>
                  {agent.latest_thread.title}
                </Truncate>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  {agent.latest_thread.last_turn ? (
                    <Truncate className="min-w-0 flex-1 text-tiny text-muted" title={agent.latest_thread.last_turn}>
                      {agent.latest_thread.last_turn}
                    </Truncate>
                  ) : (
                    <span className="flex-1 text-tiny text-faint">Nothing said in it yet</span>
                  )}
                  {/* WHAT IT LAST RAN ON: the provider's own mark, then the model's name — the
                      product owner's call, and it replaces a mono chip that printed the PROVIDER
                      string ("anthropic") and called itself the model.

                      ONLY WHEN IT HAS RUN. `agents` has no model column, so there is no such thing
                      as this agent's model to print; what exists is what the last run used, and an
                      agent nobody has run has nothing here rather than a guess. See
                      `AgentCardView.last_model`.

                      THE MARK IS THE BRAND'S AND THE NAME IS THE CATALOGUE'S. `ProviderMark` draws
                      the provider in its own colour — the one saturated thing on this line, which
                      is the whole reason it is legible at 10px — and `last_model` arrives already
                      resolved from `pricing.json`, so "Opus 5" rather than `claude-opus-5`. */}
                  {agent.last_model && (
                    <span
                      className="flex shrink-0 items-center gap-1 text-tiny text-muted"
                      title={`Last ran on ${agent.last_model}`}
                    >
                      <ProviderMark provider={agent.last_provider ?? "unknown"} size={ICON.xs} />
                      {agent.last_model}
                    </span>
                  )}
                </div>
              </>
            ) : (
              // NOTHING IS FABRICATED. §5.2: "If the agent has no threads, the line reads 'Not
              // started yet'." No invented summary, no placeholder title.
              <div className="text-caption text-faint">Not started yet</div>
            )}
          </div>
        )}

        {/* §5.2's warning line — "the single most important line on the card". Names only, and rose
            rather than amber, because amber means running and a warning must never wear it. */}
        {agent.missing_env.length > 0 && (
          <div
            className="flex min-w-0 items-center gap-1.5 text-tiny"
            style={{ color: STATUS.error }}
            title={`No credential is configured for ${agent.missing_env.join(", ")}`}
          >
            {/* A REAL GLYPH ON THE LINE THIS CARD CALLS ITS MOST IMPORTANT. It was the font
                character ⚠, which inherits the text weight rather than ICON.strokeWidth — the
                one mark on the card that was not drawn by the icon system. */}
            <span className="shrink-0" aria-hidden><AlertTriangleIcon size={ICON.badge} /></span>
            <Truncate className="min-w-0">
              {agent.missing_env.length === 1
                ? `1 credential missing — ${agent.missing_env[0]}`
                : `${agent.missing_env.length} credentials missing — ${agent.missing_env.join(", ")}`}
            </Truncate>
          </div>
        )}

        {/* §5.5's clickable sparkline, and the deploy dot beside it — RENDERED ONLY WHEN EITHER HAS
            SOMETHING TO SAY. An agent that has never run has no bars and one that is not deployed
            has no dot, so on a fresh workspace this row was a band of empty space between the
            current-work line and the footer, on every card at once. A row that is blank on every
            card is not a row; it is the awkward vertical gap it looks like. */}
        {(agent.outcomes.length > 0 || agent.deployment?.status === "live") && (
        <div className="flex min-w-0 items-center gap-2">
          <AgentSparkline outcomes={agent.outcomes} max={compact ? 12 : 20} height={compact ? 10 : 12} />
          {agent.deployment?.status === "live" && (
            <span
              className="ml-auto flex shrink-0 items-center gap-1 text-tiny"
              style={{ color: agent.drift ? STATUS.error : STATUS.ok }}
              title={
                agent.drift
                  ? `Deployed from v${agent.drift.deployed}; this agent is now at v${agent.drift.current}`
                  : agent.deployment.url ?? "Serving on a public URL"
              }
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} aria-hidden />
              {agent.drift ? `v${agent.drift.deployed} → v${agent.drift.current}` : "live"}
            </span>
          )}
        </div>
        )}

        {/* §5.2's footer, and the one action the card owns. `mt-auto` so a card with a short
            current-work line still puts its footer on the bottom edge — a grid whose footers sit at
            different heights reads as misaligned rather than as varied. */}
        <div className="mt-auto flex min-w-0 items-center gap-2 border-t border-hair pt-2 text-tiny text-faint">
          <span className="tabular-nums" title={`${agent.thread_count} open thread${agent.thread_count === 1 ? "" : "s"}`}>
            {agent.thread_count} thread{agent.thread_count === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span title={`${agent.runs_7d} run${agent.runs_7d === 1 ? "" : "s"} in the last 7 days`}>
            {ACTIVITY_LABEL[agent.activity]}
          </span>
          {/* THE FIGURE ONLY WHEN THERE IS ONE. Null is "nothing spent", never `$0` — the same rule
              `creation_cost` follows, and `spend_known: false` renders the floor with a `+`. */}
          {spend !== null && (
            <>
              <span aria-hidden>·</span>
              <span
                className="tabular-nums"
                title={agent.spend_known ? "Spend over the last 7 days" : "A floor — something here ran on an unpriced model"}
              >
                {fmtCost(spend)}
                {!agent.spend_known && "+"}
              </span>
            </>
          )}
          {/* §7.2: LAST ACTIVE. The dot separator goes with it — a chip is its own boundary, and a
              `·` before a bordered pill is a separator between a sentence and an object. */}
          {agent.last_run_at && <DateChip at={agent.last_run_at} title={`Last active ${absTime(agent.last_run_at)}`} />}
          {/* Team workspaces only. In a personal one this is a picture of the only person who could
              have made it, which is a pixel spent saying nothing. */}
          {creatorInitial && (
            <span
              // THE ACCOUNT ROW'S TREATMENT. This was a 16px circle with a 9px muted initial
              // against the sidebar's 20px rounded square with an 11px ink one — two
              // initial badges in one app at two shapes, two sizes and two ink levels. And it
              // was `aria-hidden` while carrying a `title`, so the tooltip sat on an element
              // removed from the accessibility tree and reached nobody.
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-control bg-active text-tiny text-ink"
              title="Who created this agent"
              role="img"
              aria-label="Who created this agent"
            >
              {creatorInitial}
            </span>
          )}
        </div>

        {/* §5.2'S PRIMARY ACTION, AS A BUTTON THAT LOOKS LIKE ONE — the product owner's call, and it
            moved here from the icon cluster at the top of the card. Inside the content block rather
            than on the frame, because it acts on the agent the block describes.

            A CYLINDER: `rounded-pill`, which is the one rung §04 reserves for a shape whose corners
            are its full height. That is the rung's stated use — "status tags, badges and semantic
            pills only" — and this is the exception the product owner asked for by name; it earns it
            by being the only control on the card with a label, so nothing else can be confused for
            it.

            FULL WIDTH, AND THAT WAS THE OLD OBJECTION. A glyph was chosen over "a full-width
            outlined button under everything" because three cards across meant three outlined bars
            competing with three agent names. The names are 16px/600 now and the bar is a filled
            pill at the bottom of a recessed block — the hierarchy the objection was about runs the
            other way, so the bar reads as the card's floor rather than as a rival to its title.

            ABSENT FOR AN ARCHIVED AGENT, which §4 requires: an agent that has been put away should
            not offer work. The footer above is then the last thing in the card, which is what it
            always was. */}
        {!agent.archived_at && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNewThread();
            }}
            title={`Start a new thread on ${agent.name}`}
            className="mt-0.5 flex w-full items-center justify-center gap-1.5 rounded-pill bg-chrome py-2 text-caption text-ink transition-colors duration-fast hover:bg-active active:bg-chrome focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <Icon.agents.newThread size={ICON.sm} />
            New Thread
          </button>
        )}

        </div>
      </div>
    </div>
  );
}

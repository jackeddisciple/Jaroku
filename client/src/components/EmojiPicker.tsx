// §8.5's picker: the whole palette, the current choice held down, and a shuffle.
//
// IN THE AGENT IDENTITY SECTION, BESIDE THE AVATAR, which is where somebody looks when they want to
// change what an agent looks like — the same region that holds the name and the rename control.
//
// TAKING A MARK ANOTHER AGENT ALREADY HAS IS ALLOWED AND WARNED — §8.5, and the argument is worth
// keeping: it is their workspace, and a hard block on a cosmetic choice feels worse than a
// duplicate. So a taken mark is drawn with a quiet dot rather than disabled, the tooltip names the
// agent it collides with, and the server answers a duplicate with a notice on the agents channel
// rather than a refusal.
//
// THE SHUFFLE RE-RUNS THE COLLISION-AVOIDING ASSIGNMENT rather than picking at random, which is the
// same function the server uses at creation — `assignEmoji`, over the same palette, off the same
// FNV-1a. A random button here would propose marks the server would then have to police, and the
// two would disagree the first time the workspace was full.
//
// THE GRID CELLS ARE BUTTONS AND THE EMOJI INSIDE THEM ARE STILL BARE. §8.4's no-container rule is
// about the RENDER SITES — the sidebar row, the card, the header — where a box around an identity
// mark would be the first filled container in the product. A picker is a control: its cells are hit
// targets, and a 32px glyph with nothing to press is a picker nobody can use. The mark itself still
// carries no background, no border and no fixed box; the button around it is the control.
//
//   npm run test:emoji-render

import { EMOJI_PALETTE, assignEmoji } from "../lib/emojiPalette.ts";
import { HIT_TARGET } from "./icons.ts";
import { AgentEmoji, EMOJI_SIZE } from "./AgentEmoji.tsx";
import { Icon } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

export function EmojiPicker({
  uuid,
  current,
  takenBy,
  onChoose,
}: {
  /** The agent's uuid — what the shuffle hashes, exactly as the server's assignment does. */
  uuid: string;
  current: string | null | undefined;
  /** Every mark this workspace already spends, by the name of the agent spending it. */
  takenBy: ReadonlyMap<string, string>;
  onChoose: (emoji: string) => void;
}) {
  const taken = [...takenBy.keys()].filter((e) => e !== current);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {/* THE CURRENT CHOICE, AT THE PICKER'S OWN SIZE — bare, so what somebody is looking at while
            they choose is exactly what the sidebar will draw. */}
        <AgentEmoji emoji={current} size={EMOJI_SIZE.picker} />
        <IconButton
          icon={Icon.agents.shuffleEmoji}
          label="Pick a different mark"
          onClick={() => onChoose(assignEmoji(uuid, taken))}
        />
      </div>
      <div role="radiogroup" aria-label="Agent mark" className="flex flex-wrap gap-0.5">
        {EMOJI_PALETTE.map((e) => {
          const owner = e === current ? undefined : takenBy.get(e);
          return (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={e === current}
              // THE NAME IS THE MARK'S OWN CHARACTER, which is the one place in this feature where a
              // screen reader should hear it: every render site is `aria-hidden` because the agent's
              // name is beside it, and here there is no name — the mark IS the choice.
              aria-label={owner ? `${e}, already worn by ${owner}` : e}
              title={owner ? `${owner} already wears this` : undefined}
              onClick={() => onChoose(e)}
              style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
              className={`relative inline-flex items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
                e === current ? "bg-active" : "hover:bg-active"
              }`}
            >
              <AgentEmoji emoji={e} size={EMOJI_SIZE.sidebar} />
              {/* ALLOWED, BUT SAID. A dot rather than a disabled cell: the choice is still offered
                  and the collision is still visible before it is made. */}
              {owner && <span aria-hidden className="absolute bottom-1 h-0.5 w-0.5 rounded-full bg-faint" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

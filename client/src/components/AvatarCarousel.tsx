// The one place an avatar is chosen: a strip of characters you scroll through, with the one in the
// middle bigger than its neighbours.
//
// WHY A CAROUSEL AND NOT THE GRID THIS REPLACES. A grid of twenty-eight tiles asks somebody to
// compare twenty-eight things at once, which is a spreadsheet; a strip asks them to look at ONE and
// then the next. That is the right shape for a decision nobody has a reason to agonise over, and it
// is the only shape in which a live 3D character can be given enough size to be worth rendering —
// the centre tile here is bigger than any tile in the grid it replaces, and every other tile is
// smaller, so the total cost goes DOWN while the thing you are looking at gets larger.
//
// THE SIZE IS THE SELECTION. Nothing has a tick, a ring or a border: whichever character is in the
// middle is the one you have chosen, and it says so by being the biggest thing on the row. That is
// also why the scale is continuous rather than a two-state swap — halfway through a scroll you are
// halfway between two choices, and the strip should look like it.
//
// AND IT IS THE DOM THAT SCALES, NOT THE RENDERER. `GlossStage` measures each avatar box every frame
// and draws the character into whatever rectangle it finds, so growing the BOX grows the character
// with no second code path, no per-tile camera and nothing for the two to disagree about. The scroll
// wakes the loop, which drops its frame gate for the duration — see `INTERACTIVE_MS` — so the
// characters resize on every frame of the scroll rather than every fourth.
//
// THE ENDS FADE rather than stopping at a hard edge, because a hard edge reads as the end of the
// list. A gradient says there is more in both directions, which there is.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { GlossAvatar } from "./GlossAvatar.tsx";
import { GLOSS_ROSTER } from "../lib/gloss/roster.ts";

/**
 * The centre tile's size, and how small the ones at the edges get.
 *
 * THE BOX IS ALWAYS `TILE`; the scale is a transform on top of it. Laying out at the scaled size
 * would reflow the whole strip on every frame of a scroll — twenty-eight boxes changing width while
 * the browser is trying to scroll them — and a transform is composited instead of laid out.
 */
const TILE = 104;
const SCALE = { near: 1, far: 0.55 } as const;
/** How far from the centre a tile has to be before it is at `SCALE.far`, as a share of the rail. */
const REACH = 0.42;

export function AvatarCarousel({
  current,
  onChoose,
}: {
  current: string | null;
  onChoose: (avatarId: string) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<(HTMLDivElement | null)[]>([]);
  const frame = useRef<number | null>(null);
  /** The last id reported, so a scroll that crosses one tile does not fire `onChoose` per frame. */
  const reported = useRef<string | null>(current);

  /**
   * Size every tile by how near the middle it is, and report whichever is nearest.
   *
   * WRITTEN STRAIGHT TO THE ELEMENTS, not through state. Twenty-eight tiles re-rendered on every
   * frame of a scroll is React doing a hundred times the work the browser is, to produce a number
   * that is only ever used as a transform. The one thing that DOES go through React is the
   * selection, and it changes once per tile crossed rather than once per frame.
   */
  const settle = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const mid = rail.scrollLeft + rail.clientWidth / 2;
    const reach = Math.max(1, rail.clientWidth * REACH);
    let nearest = { d: Infinity, id: reported.current };
    tilesRef.current.forEach((tile, i) => {
      if (!tile) return;
      const centre = tile.offsetLeft + tile.offsetWidth / 2;
      const d = Math.abs(centre - mid);
      const t = Math.min(1, d / reach);
      // SMOOTHSTEP RATHER THAN LINEAR, so a tile does not begin shrinking the instant it leaves the
      // exact centre — the middle of the strip has a small plateau where the character is at full
      // size, which is what makes the centred one read as chosen rather than as merely nearest.
      const eased = t * t * (3 - 2 * t);
      const scale = SCALE.near + (SCALE.far - SCALE.near) * eased;
      tile.style.transform = `scale(${scale.toFixed(4)})`;
      tile.style.opacity = String(1 - eased * 0.55);
      // A shrunken character must not still claim a full tile's worth of hit area.
      tile.style.zIndex = String(Math.round((1 - t) * 10));
      if (d < nearest.d) nearest = { d, id: GLOSS_ROSTER[i]!.id };
    });
    if (nearest.id && nearest.id !== reported.current) {
      reported.current = nearest.id;
      onChoose(nearest.id);
    }
  }, [onChoose]);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      settle();
    });
  }, [settle]);

  // Size the tiles before the first paint, or the strip appears flat and then jumps.
  useLayoutEffect(settle);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  /** Put a given entry in the middle. Used for the initial position and for the arrow keys. */
  const centreOn = useCallback((index: number, behavior: ScrollBehavior) => {
    const rail = railRef.current;
    const tile = tilesRef.current[index];
    if (!rail || !tile) return;
    rail.scrollTo({ left: tile.offsetLeft + tile.offsetWidth / 2 - rail.clientWidth / 2, behavior });
  }, []);

  // THE STRIP OPENS ON THE CHOSEN ONE rather than at the start, so re-entering the step shows what
  // was picked rather than making somebody find it again. Instant, because an animation on first
  // paint reads as the page still loading.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const index = Math.max(0, GLOSS_ROSTER.findIndex((r) => r.id === current));
    centreOn(index, "auto");
    settle();
  }, [current, centreOn, settle]);

  const step = (delta: number): void => {
    const at = GLOSS_ROSTER.findIndex((r) => r.id === reported.current);
    const next = Math.max(0, Math.min(GLOSS_ROSTER.length - 1, (at < 0 ? 0 : at) + delta));
    centreOn(next, "smooth");
  };

  return (
    <div
      // THE FADE IS A MASK ON THE CONTAINER, not a pair of overlaid gradients. An overlay has to
      // know the background colour behind it; a mask does not, which is what lets this sit on the
      // onboarding screen and anywhere else without being retuned.
      // BREAKING OUT OF THE CARD'S PADDING, which is what turns three tiles into five. A strip has to
      // look like a strip: with a tile either side of the centre and both of them clipped by the
      // fade, it reads as a list that continues; hemmed inside the padding it reads as three
      // options with two of them shrunk.
      className="relative -mx-7"
      style={{
        maskImage: "linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)",
        WebkitMaskImage: "linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)",
      }}
    >
      <div
        ref={railRef}
        onScroll={onScroll}
        role="radiogroup"
        aria-label="Choose an avatar"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        }}
        // `snap-mandatory` SO IT ALWAYS COMES TO REST ON SOMEBODY. Without it a flick leaves the
        // strip between two characters, which is a selection nobody made. The horizontal padding is
        // half the rail, so the first and last entries can reach the middle like every other one.
        className="flex snap-x snap-mandatory items-center gap-2 overflow-x-auto overflow-y-hidden py-2
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-none"
        style={{ paddingInline: "calc(50% - " + TILE / 2 + "px)" }}
      >
        {GLOSS_ROSTER.map((entry, i) => (
          <div
            key={entry.id}
            ref={(el) => { tilesRef.current[i] = el; }}
            className="flex shrink-0 snap-center flex-col items-center will-change-transform"
            style={{ width: TILE }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={entry.id === current}
              aria-label={entry.label}
              onClick={() => centreOn(i, "smooth")}
              className="rounded-control focus-visible:outline-none focus-visible:shadow-focusring"
            >
              <GlossAvatar
                agentKey={`carousel:${entry.id}`}
                avatarId={entry.id}
                emoji={null}
                size={TILE}
              />
            </button>
            <span className="mt-1 select-none text-tiny text-faint">{entry.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The React half of I1: one canvas over the grid, and a component that is a hole in a card.
//
// A `<GlossAvatar>` DRAWS NOTHING ITSELF. It is a sized, transparent box that tells the stage where
// it is; the character arrives on the shared canvas floating above the grid, in the rectangle this
// box occupies. That indirection is the whole point — twenty cards each owning a canvas is twenty
// WebGL contexts against a browser budget of eight to sixteen, and past the cap the browser kills
// the oldest silently. See `lib/gloss/GlossStage.ts`.
//
// THE CANVAS SITS ABOVE THE GRID AND BELOW CARD CHROME, which sounds contradictory and is not. It is
// cleared to full transparency and only ever painted inside slot rectangles, so borders, tags and
// footers show through untouched; and anything that OPENS over a card — the overflow menu, a
// tooltip — carries a z-index above it, so it lands on top of a character rather than under one.
// `pointer-events: none` means the cards keep every click.
//
// THREE THINGS ARE ON SCREEN AT DIFFERENT MOMENTS, and only one at a time:
//
//   THE PLACEHOLDER — the agent's emoji, at avatar size, while the character is still in the build
//   queue. §4.2 asks for "a neutral placeholder until its character lands" and this is the one the
//   product already has: it is the same identity mark the sidebar shows, so a card that has not
//   finished building is not a card showing nothing.
//
//   THE CHARACTER — once built, drawn on the shared canvas. The placeholder comes down at that
//   moment and not before, because a character does not fill its box and a placeholder left up
//   shows through around it.
//
//   THE PLACEHOLDER AGAIN, FOR EVER — when there is no WebGL at all. That is the static fallback
//   path, and it is deliberately the emoji rather than a grey square: a workspace on a machine
//   without a GPU should look like the product minus one feature, not like a product with holes in
//   it.

import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";

import { GlossLoop } from "../lib/gloss/GlossBudget.ts";
import { GlossStage } from "../lib/gloss/GlossStage.ts";
import { RADIUS } from "../lib/tokens.ts";
import { AgentEmoji } from "./AgentEmoji.tsx";

/** The sizes an avatar is drawn at. Two, and both are above §I4's floor. */
export const AVATAR_SIZE = {
  /**
   * In an Agents grid card.
   *
   * SIXTY-FOUR IS THE FLOOR THIS PRODUCT WILL DRAW 3D AT. I4: "a glossy 3D character at 16px is a
   * smudge, and running the renderer to produce a smudge is the worst of both". The curation pass
   * chose these characters by looking at them at 96px; 64 is what a compact card can spare and is
   * still a face rather than a blob.
   */
  card: 64,
  /** The agent detail header, where there is room for the character to be looked at. */
  header: 96,
} as const;

interface StageHandle {
  stage: GlossStage | null;
  loop: GlossLoop | null;
}

/**
 * Null outside a provider, and that is a supported state rather than an error.
 *
 * An avatar rendered with no stage above it shows its emoji and nothing else. That is what makes
 * `GlossAvatar` safe to put on a surface before the provider reaches it, and what makes the
 * no-WebGL path fall out rather than needing a branch of its own.
 */
const StageContext = createContext<StageHandle>({ stage: null, loop: null });

/**
 * Owns the one renderer, the loop, and the canvas the whole grid draws into.
 *
 * MOUNTED ONCE, AROUND A SURFACE — not around the application. The stage is cheap to make and
 * expensive to keep: it holds a GL context, a prefiltered environment and every built character's
 * geometry, so it lives exactly as long as the surface that shows avatars.
 */
export function GlossStageProvider({
  active,
  children,
}: {
  /** Is this surface the one on screen? The loop parks whenever it is not. */
  active: boolean;
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<StageHandle>({ stage: null, loop: null });

  useEffect(() => {
    let stage: GlossStage;
    try {
      stage = new GlossStage();
    } catch {
      // NO WEBGL, OR A CONTEXT THE BROWSER REFUSED TO GIVE. Both happen: a machine with no GPU
      // driver, a browser with hardware acceleration off, and — the one that is easy to forget —
      // an application that already holds as many contexts as the browser will allow. Every avatar
      // falls back to its emoji, which is the product minus one feature rather than a broken grid.
      setHandle({ stage: null, loop: null });
      return;
    }
    const canvas = stage.canvas;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    // ABOVE THE CARDS, BELOW ANYTHING THAT OPENS. See the header.
    canvas.style.zIndex = "1";
    canvas.style.pointerEvents = "none";
    hostRef.current?.appendChild(canvas);

    const loop = new GlossLoop(stage);
    loop.start();
    setHandle({ stage, loop });
    return () => {
      loop.stop();
      stage.dispose();
      canvas.remove();
      setHandle({ stage: null, loop: null });
    };
  }, []);

  useEffect(() => {
    handle.loop?.setActive(active);
  }, [handle.loop, active]);

  /**
   * Anything that can move a card re-measures.
   *
   * SCROLL IS CAPTURED AT THE WINDOW, because the grid scrolls inside a pane rather than the
   * document and a bubbling listener never sees it — `scroll` does not bubble. Capture catches every
   * scroll in the tree, which is what is wanted: any of them can move a card.
   *
   * IT ONLY WAKES THE LOOP. The measurement itself happens inside the loop's own tick, so all the
   * rect reads in the application stay on one line in one place — §4.1's whole point. A handler that
   * measured here would be a `getBoundingClientRect` per scroll event, which is the layout thrash
   * this arrangement exists to avoid, arriving through the back door.
   */
  useEffect(() => {
    const loop = handle.loop;
    const host = hostRef.current;
    if (!loop || !host) return;
    const wake = () => loop.wake();
    window.addEventListener("scroll", wake, true);
    const observer = new ResizeObserver(wake);
    observer.observe(host);
    return () => {
      window.removeEventListener("scroll", wake, true);
      observer.disconnect();
    };
  }, [handle.loop]);

  return (
    // `position: relative` so the canvas can be inset to this box, and `isolation: isolate` so the
    // canvas's z-index is scoped to the grid rather than competing with the app's modals.
    <div ref={hostRef} className="relative isolate h-full min-h-0">
      {children}
    </div>
  );
}

/**
 * One agent's avatar: a hole in the card, and the emoji until the character fills it.
 *
 * KEYED BY THE AGENT, NOT BY THE AVATAR. Two agents may wear the same avatar — §6 allows it and only
 * warns — so the slot key has to be the thing that is unique per card. A key of `avatarId` would
 * make two agents share one slot and one of them would draw nowhere.
 */
export function GlossAvatar({
  agentKey,
  avatarId,
  emoji,
  size = AVATAR_SIZE.card,
  className = "",
}: {
  /** Unique per rendered card. The agent's slug or uuid. */
  agentKey: string;
  /** A roster id, or null for an agent that predates the backfill. */
  avatarId: string | null | undefined;
  /** The small-size identity, used as the placeholder and as the no-WebGL fallback. */
  emoji: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const { stage, loop } = useContext(StageContext);
  const boxRef = useRef<HTMLDivElement>(null);
  const [built, setBuilt] = useState(false);

  // A LAYOUT EFFECT, so the slot is registered before the browser paints. Registered in a passive
  // effect the card's first painted frame has a rect the stage has not seen, and the character
  // appears one frame late in a box that was already on screen — a visible pop on every scroll.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!stage || !box || !avatarId) return;
    stage.mount(agentKey, box, avatarId);
    loop?.wake();
    return () => {
      stage.unmount(agentKey);
      setBuilt(false);
    };
  }, [stage, loop, agentKey, avatarId]);

  useEffect(() => {
    if (!stage) return;
    return stage.onBuilt((key) => {
      if (key === agentKey) setBuilt(stage.hasCharacter(agentKey));
    });
  }, [stage, agentKey]);

  const style = useMemo(
    () => ({ width: size, height: size, borderRadius: RADIUS.card }),
    [size],
  );

  return (
    <div
      ref={boxRef}
      style={style}
      // NO BACKGROUND, NO BORDER, NO RING. The card already has a radius and an elevation; an avatar
      // that drew its own would be a box inside a box, which is the one thing the emoji work spent a
      // whole commit removing one size down.
      className={`relative flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      aria-hidden
    >
      {/* THE PLACEHOLDER, AND IT IS THE AGENT'S OWN MARK. Held at roughly half the box so it reads
          as a stand-in rather than as a design; it comes down the moment the character lands, and
          stays for ever when there is no renderer at all. */}
      {!built && <AgentEmoji emoji={emoji} size={Math.round(size * 0.44)} />}
    </div>
  );
}

// ONE WebGL CONTEXT, FOR THE WHOLE APPLICATION. I1, and the invariant everything else hangs off.
//
// WHY IT IS NOT ONE CANVAS PER CARD, which is the obvious build and the one that fails in a way
// nobody can reproduce. Browsers cap live WebGL contexts at roughly eight to sixteen and silently
// kill the OLDEST past that — no exception, no console error, just a canvas that stops painting. A
// twenty-agent grid of per-card canvases therefore produces cards that go blank at random, on the
// machines with the most agents, and looks perfect on the four-agent workspace a developer has open.
//
// So: one `WebGLRenderer` on one canvas positioned over the grid, and each character drawn into the
// rectangle of its own card with `setScissor` / `setViewport`. That is upstream's own arrangement in
// `gcrowd.js` — a flat grid of cells drawn straight on — with the grid maths replaced by DOM rects,
// because here the cells are cards the browser lays out rather than a lattice this file invents.
//
// WHAT THIS FILE OWNS AND WHAT IT DOES NOT. It owns the renderer, the scene, the slot table, the
// build queue and the per-frame draw. It does NOT own when to run: `frame()` is called from outside,
// and the gating — tab visibility, window blur, reduced motion, the offscreen freeze and the
// animating cap — arrives in `GlossBudget`. Splitting them that way keeps this testable without a
// browser and keeps the throttle from being something bolted on afterwards.
//
// THE ANIMATION IS PORTED, NOT INVENTED, and §2.4 is right that this is the part most easily lost.
// Blink, gaze, saccades and the head whipping after the gaze all live in the vendored `gface.js`.
// Breath and sway do not live in a module at all — they are about fifteen lines inside `gcrowd.js`'s
// `animate()`, the one file that was deliberately not copied — so they are re-typed here, deliberately,
// with the arithmetic preserved rather than re-derived. See `animateSlot`.
//
//   npm run test:gloss-stage

import * as THREE from "../../../vendor/three.module.js";

import { buildGloss, ensureGParams } from "./grig.js";
import { createGlossFace } from "./gface.js";
import { dressScene, makeMaterialFactory, studioEnv } from "./gmedia.js";
import { toGlossRecipe } from "./recipe.ts";
import { ROSTER_BY_ID } from "./roster.ts";
import type { BuiltGloss, GlossFaceLife, MaterialFor } from "./types.ts";

/**
 * How much of a cell a character fills, and the three ways it is fitted into one.
 *
 * COPIED FROM UPSTREAM'S `buildSlot`, INCLUDING THE TWO ESCAPE HATCHES, because both were paid for.
 * The head is what gets normalised — a sheet of faces wants every face the same size — but fitting
 * by the head ALONE let a tall haircut climb out of the cell, and fitting by the whole character
 * shrank a long-haired head to a pebble to make room for its own hair. So: size by the head, and
 * fall back to the total only when the total would get out of hand, on both axes.
 */
const FIT = { budget: 0.74, byHeight: 1.28, byWidth: 1.2 } as const;

/** The lens. A long-ish 26° so a grid barely converges and a character reads as an object. */
const FOV = 26;

/**
 * Breath and sway, from `gcrowd.js`'s `animate()`.
 *
 * THE BREATH IS VOLUME-PRESERVING AND THAT IS THE WHOLE POINT: `y` is multiplied by `sy` while `x`
 * and `z` are DIVIDED by its square root, so the character reads as taking a breath rather than as
 * inflating. Copying the arithmetic rather than re-deriving it is deliberate — the obvious version
 * (scale y, leave x and z) is what makes a character look like it is being pumped up.
 *
 * SWAY IS SIZED AS A FRACTION OF THE CELL upstream, where a cell is one world unit. Here the cell is
 * the card's avatar box, and the character is fitted into a box one unit across, so the fractions
 * carry over unchanged.
 */
const LIFE = {
  breathRate: 1.8,
  breathDepth: 0.008,
  swayXRate: 0.55,
  swayXDepth: 0.008,
  swayYRate: 0.37,
  swayYDepth: 0.006,
} as const;

/** One mounted avatar. The element is the card's own box; the rect is measured, never asked for. */
interface Slot {
  key: string;
  avatarId: string;
  element: HTMLElement;
  built: BuiltGloss | null;
  holder: THREE.Group | null;
  life: GlossFaceLife | null;
  scale: number;
  /**
   * Per-slot rate and phase, and §2.4 is emphatic about why. Without them twenty agents blink in
   * perfect unison, which is unsettling in a way people notice before they can say what is wrong.
   */
  rate: number;
  phase: number;
  /** Last measured position, in canvas pixels with y up. Refreshed by `measure`, never per draw. */
  x: number;
  y: number;
  size: number;
  onScreen: boolean;
}

/**
 * The pieces of the vendored runtime the stage reaches for, injectable.
 *
 * ONLY SO THE SUITE CAN COUNT CONTEXTS. `test:gloss-stage` has to assert "exactly one WebGLRenderer
 * is ever constructed" and "a hundred mount/unmount cycles leave no geometry retained", and neither
 * is answerable from Node with a real renderer, because a real renderer needs a GL context.
 *
 * WHAT IS *NOT* INJECTABLE IS THE PART THAT MATTERS. `buildGloss` and the disposal walk stay real in
 * the suite: geometries are plain objects and construct fine without a context, so the geometry-leak
 * assertion runs against the code that ships rather than against a mock of it. Faking the renderer
 * proves the stage builds one; faking the builder would have proved nothing at all.
 */
export interface StageBindings {
  createRenderer(): THREE.WebGLRenderer;
  makeMaterialFor(renderer: THREE.WebGLRenderer): MaterialFor;
  dress(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void;
}

/** The real ones. A separate object so the suite substitutes rather than monkey-patches. */
export const REAL_BINDINGS: StageBindings = {
  createRenderer: () =>
    new THREE.WebGLRenderer({
      antialias: true,
      // TRANSPARENT, so the card's own surface is the background. Upstream paints an opaque warm
      // taupe wall because its page IS that colour; here an opaque plane per card would be the first
      // filled box in a product drawn entirely in hairlines, twenty times over on one screen.
      alpha: true,
      powerPreference: "low-power",
    }),
  makeMaterialFor: (renderer) => makeMaterialFactory(studioEnv(renderer)),
  dress: (scene, renderer) => {
    // THE WALL VARIANT, NOT THE FLOOR ONE. A grid of cards has no ground for a character to stand on
    // — the floor rig needs one — so the shadow lands on a plane just behind, which is what gives a
    // card depth without the camera needing any.
    const dressed = dressScene(scene, renderer, { shadows: "wall", span: 3.2, wallZ: 0.5 }) as {
      wall?: { material: unknown };
    };
    // AND THE WALL IS SWAPPED FOR A SHADOW CATCHER, which is the same trick upstream's own floor
    // variant uses one branch down: `ShadowMaterial` draws the shadow and nothing else, so the card
    // shows through and the character keeps the contact shadow that stops it floating. Opacity is
    // upstream's `pool` default.
    if (dressed.wall) dressed.wall.material = new THREE.ShadowMaterial({ opacity: 0.19 });
    scene.background = null;
  },
};

/**
 * How many characters may be built in one frame's worth of work, in milliseconds.
 *
 * A TIME BUDGET RATHER THAN A COUNT, as upstream: a character costs roughly twenty milliseconds to
 * subdivide, but that is a number measured on one machine with one haircut, and a count tuned on a
 * fast laptop is a count that stutters on a slow one. Eight milliseconds is half a 60 Hz frame, so
 * a grid fills in over a few hundred milliseconds on anything and freezes on nothing. §4.2: "a grid
 * that fills in over three hundred milliseconds is fine; a grid that freezes for three hundred
 * milliseconds is not."
 */
const BUILD_BUDGET_MS = 8;

export class GlossStage {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly materialFor: MaterialFor;
  private readonly slots = new Map<string, Slot>();
  /** Mounted but not yet built, in mount order — which is view order, because React mounts in it. */
  private queue: Slot[] = [];
  private readonly builtListeners = new Set<(key: string) => void>();
  private width = 0;
  private height = 0;
  private disposed = false;

  constructor(bindings: StageBindings = REAL_BINDINGS) {
    this.renderer = bindings.createRenderer();
    // §4.3, as upstream. Past 2 the cost is quadratic in pixels and the difference is invisible on
    // a 96px character.
    this.renderer.setPixelRatio(Math.min(devicePixelRatioOr(1), 2));
    this.scene = new THREE.Scene();
    bindings.dress(this.scene, this.renderer);
    this.materialFor = bindings.makeMaterialFor(this.renderer);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    // The camera never moves. Every slot is drawn with the same square viewport at the same
    // distance, so a character is the same size in every card whatever the card is doing.
    this.camera.position.set(0, 0, 0.5 / Math.tan((FOV * Math.PI) / 360) + 1);
    this.camera.lookAt(0, 0, 0);
  }

  /** The canvas to position over the grid. `pointer-events: none` is the caller's business. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Every slot currently mounted, built or queued. */
  get size(): number {
    return this.slots.size;
  }

  /** How many characters have geometry right now. The suite's leak assertion reads this. */
  get builtCount(): number {
    let n = 0;
    for (const slot of this.slots.values()) if (slot.built) n++;
    return n;
  }

  /**
   * How many geometries this stage is holding.
   *
   * A GETTER ON THE STAGE RATHER THAN A REACH INTO ITS INSIDES, because §8 asks for exactly this
   * question — "mounting and unmounting 100 slots leaves no geometry retained" — and a suite that
   * answered it by walking a private map would be a suite that breaks when the map changes shape
   * rather than when the leak comes back.
   */
  get geometryCount(): number {
    let n = 0;
    for (const slot of this.slots.values()) {
      slot.built?.group.traverse((node) => { if (node.geometry) n++; });
    }
    return n;
  }

  /**
   * Register a card's avatar box.
   *
   * NOTHING IS BUILT HERE. Twenty characters subdivided at once is a CPU spike on grid open, so a
   * mount joins the queue and `frame` drains it against a time budget. Until then the card shows
   * whatever placeholder it drew for itself, which is the difference between a grid that fills in
   * and a grid that freezes.
   */
  mount(key: string, element: HTMLElement, avatarId: string): void {
    const existing = this.slots.get(key);
    if (existing) {
      // A REMOUNT WITH A DIFFERENT AVATAR IS A REBUILD, and one with the same avatar is not. The
      // second case is the common one — React re-runs an effect because a parent re-rendered — and
      // rebuilding there would throw away twenty milliseconds of work per card per broadcast.
      existing.element = element;
      if (existing.avatarId === avatarId) return;
      this.release(existing);
      existing.avatarId = avatarId;
      this.queue.push(existing);
      return;
    }
    const slot: Slot = {
      key, avatarId, element,
      built: null, holder: null, life: null, scale: 1,
      // §2.4: every slot needs its own rate and phase, or twenty agents blink together.
      rate: 0.85 + Math.random() * 0.35,
      phase: Math.random() * 20,
      x: 0, y: 0, size: 0, onScreen: false,
    };
    this.slots.set(key, slot);
    this.queue.push(slot);
  }

  /**
   * Unregister a card and free its geometry.
   *
   * DISPOSAL IS NOT OPTIONAL AND NOT AUTOMATIC. Three.js frees GPU buffers on an explicit
   * `dispose()`; nothing is reference-counted, and a geometry dropped without one stays resident for
   * the life of the context. A grid somebody scrolls through for a minute mounts and unmounts
   * hundreds of cards, so the leak this prevents is not theoretical — it is the ordinary case.
   * `test:gloss-stage` mounts and unmounts a hundred slots and asserts nothing is retained.
   */
  unmount(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.release(slot);
    this.slots.delete(key);
    this.queue = this.queue.filter((s) => s !== slot);
  }

  /** Drop a slot's character, keeping the slot. Upstream's `clearSlot`, and its discipline. */
  private release(slot: Slot): void {
    if (!slot.built || !slot.holder) return;
    this.scene.remove(slot.holder);
    slot.built.group.traverse((node) => node.geometry?.dispose());
    slot.built = null;
    slot.holder = null;
    slot.life = null;
    for (const listener of this.builtListeners) listener(slot.key);
  }

  /**
   * Measure every slot's rectangle, in ONE pass.
   *
   * BATCHED ON PURPOSE, and §4.1 names this as the thing that will bite. A `getBoundingClientRect`
   * per card per frame is a layout thrash: each call flushes pending style and layout work, so
   * twenty of them interleaved with writes is twenty forced reflows a frame. That shows up as scroll
   * jank long before the WebGL cost does, and it looks like the 3D being slow when it is not.
   *
   * All reads happen here, all writes happen in `frame`, and the two never interleave.
   */
  measure(): void {
    if (this.disposed) return;
    const canvas = this.renderer.domElement;
    const base = canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(base.width));
    this.height = Math.max(1, Math.round(base.height));
    for (const slot of this.slots.values()) {
      const r = slot.element.getBoundingClientRect();
      // A SQUARE, SIDED BY THE SHORTER EDGE, centred in whatever box the card gave us. The character
      // is fitted into a square viewport, so a non-square rect would stretch it — and the card owns
      // its own layout, so this cannot assume the box is square.
      const side = Math.min(r.width, r.height);
      slot.size = Math.round(side);
      slot.x = Math.round(r.left - base.left + (r.width - side) / 2);
      // WebGL's origin is bottom-left and the DOM's is top-left, which is the sign error every
      // scissor bug in this file's history has been.
      slot.y = Math.round(this.height - (r.top - base.top + (r.height - side) / 2) - side);
      slot.onScreen =
        side > 0 && slot.x + side > 0 && slot.x < this.width && slot.y + side > 0 && slot.y < this.height;
    }
  }

  /**
   * Build whatever fits in the budget, then draw every slot that has something to draw.
   *
   * `t` IS SECONDS AND `dt` IS SECONDS. The animation is driven by the clock rather than by the
   * frame count — upstream's own note — so halving the frame rate changes the pace of nothing; it
   * only stops drawing the same thing twice.
   */
  frame(t: number, dt: number, shouldAnimate: (key: string) => boolean = () => true): void {
    if (this.disposed) return;
    this.drain();

    const renderer = this.renderer;
    renderer.setSize(this.width, this.height, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setClearAlpha(0);
    renderer.setViewport(0, 0, this.width, this.height);
    renderer.setScissor(0, 0, this.width, this.height);
    renderer.clear();

    for (const slot of this.slots.values()) {
      if (!slot.built || !slot.holder || slot.size <= 0 || !slot.onScreen) continue;
      if (shouldAnimate(slot.key)) this.animateSlot(slot, t, dt);
      slot.holder.visible = true;
      renderer.setViewport(slot.x, slot.y, slot.size, slot.size);
      renderer.setScissor(slot.x, slot.y, slot.size, slot.size);
      renderer.render(this.scene, this.camera);
      // ONE CHARACTER PER PASS. Everything lives at the origin — the camera never moves — so the
      // scene holds twenty characters standing in the same place and visibility is what picks one.
      slot.holder.visible = false;
    }
  }

  /** Build from the queue until the budget is spent. In view order, because mounts arrive in it. */
  private drain(): void {
    if (this.queue.length === 0) return;
    const until = now() + BUILD_BUDGET_MS;
    do {
      const slot = this.queue.shift();
      if (!slot) return;
      // A slot unmounted between joining the queue and reaching the front. Its entry is filtered on
      // unmount, but a rebuild pushes the same object twice and this is cheaper than deduping.
      if (!this.slots.has(slot.key) || slot.built) continue;
      this.build(slot);
    } while (this.queue.length > 0 && now() < until);
  }

  /** Does this slot have a character on screen right now? The card's placeholder asks. */
  hasCharacter(key: string): boolean {
    return this.slots.get(key)?.built != null;
  }

  /**
   * Be told when a character lands.
   *
   * BECAUSE THE CARD DRAWS A PLACEHOLDER UNTIL IT DOES. §4.2 asks for "a neutral placeholder until
   * its character lands", and the placeholder has to come OFF at exactly the right moment: left up,
   * it shows through around a character that does not fill its box; taken down early, the card is
   * empty for the few hundred milliseconds the queue takes to reach it.
   *
   * A callback rather than a promise per slot, because a slot can be rebuilt — a card whose agent
   * changes avatar — and a promise resolves once.
   */
  onBuilt(listener: (key: string) => void): () => void {
    this.builtListeners.add(listener);
    return () => { this.builtListeners.delete(listener); };
  }

  private build(slot: Slot): void {
    const entry = ROSTER_BY_ID.get(slot.avatarId);
    // AN UNKNOWN ID DRAWS NOTHING, rather than falling back to a default character. A wrong face is
    // worse than no face: the whole promise of the roster is that an agent's avatar identifies it,
    // and a silent substitution is two agents wearing one identity with nothing to say so.
    if (!entry) return;
    const built = buildGloss(ensureGParams(toGlossRecipe(entry)), { materialFor: this.materialFor });
    const b = built.bounds;
    const scale = Math.min(
      FIT.budget / built.L.H,
      (FIT.budget * FIT.byHeight) / b.h,
      (FIT.budget * FIT.byWidth) / b.w,
    );
    const holder = new THREE.Group();
    // Centred between the head's middle and the character's, so the FACE sits where a face should
    // and a tall haircut still leans into its share of the box.
    built.group.position.y = -(b.cy + built.L.cy) / 2;
    holder.add(built.group as unknown as THREE.Object3D);
    holder.visible = false;
    this.scene.add(holder);
    slot.built = built;
    slot.holder = holder;
    slot.scale = scale;
    slot.life = createGlossFace(built, { gaze: true });
    for (const listener of this.builtListeners) listener(slot.key);
  }

  /**
   * One character's frame of life: gaze, blink, breath and sway.
   *
   * THE GAZE TURNS THE HEAD, NOT THE HOLDER. `built.head` is its own group pivoted at the head's
   * centre, so a character with a torso keeps its feet planted while it looks — turning the holder
   * would swing the whole body and read as the character leaning, not glancing. The head's offsets
   * are already in the character's own units and the head lives inside the scaled group, so there is
   * no unit conversion to get wrong.
   */
  private animateSlot(slot: Slot, t: number, dt: number): void {
    if (!slot.built || !slot.holder || !slot.life) return;
    const own = t * slot.rate + slot.phase;
    const head = slot.life.update(own, dt);

    const sy = 1 + Math.sin(own * LIFE.breathRate) * LIFE.breathDepth;
    slot.holder.position.set(
      Math.sin(own * LIFE.swayXRate) * LIFE.swayXDepth,
      Math.cos(own * LIFE.swayYRate) * LIFE.swayYDepth,
      0,
    );
    const h = slot.built.head;
    h.position.set(head.x, h.userData.restY + head.y, 0);
    h.rotation.set(head.pitch, head.yaw, head.rot);
    // Volume-preserving. See LIFE.
    const root = Math.sqrt(sy);
    slot.holder.scale.set(slot.scale / root, slot.scale * sy, slot.scale / root);
  }

  /**
   * What every slot's rectangle came out as, for the budget to rank.
   *
   * READ OFF THE LAST `measure`, NEVER FRESH. The whole point of batching the reads is that nothing
   * downstream reaches for a rect of its own — a budget that measured while deciding would put a
   * forced reflow between the measurement pass and the draw, which is the layout thrash §4.1 warns
   * about arriving through the back door.
   */
  slotMetrics(): { key: string; onScreen: boolean; built: boolean; centreDistance: number }[] {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const out = [];
    for (const slot of this.slots.values()) {
      const x = slot.x + slot.size / 2;
      const y = slot.y + slot.size / 2;
      out.push({
        key: slot.key,
        onScreen: slot.onScreen,
        built: slot.built !== null,
        centreDistance: Math.hypot(x - cx, y - cy),
      });
    }
    return out;
  }

  /**
   * What the animator has written to each built slot this frame.
   *
   * READ-ONLY, AND IT EXISTS FOR §11.5. Acceptance asks that "blink, gaze, saccade, idle, breath and
   * sway all [be] present, with per-slot rate and phase", and every one of those is invisible from
   * outside: a stage that builds characters and never animates them renders a perfectly correct
   * STILL grid, which reads as a design decision rather than as a bug. So the transforms the loop
   * writes are observable, and `test:gloss-stage` watches them move.
   *
   * It reports the transforms rather than the animator's internals on purpose. What matters is not
   * that `gface.js` has a blink in it — it does, it is vendored — but that the blink reaches a mesh
   * on this stage, through this loop, on this frame.
   */
  debugTransforms(): {
    key: string; headX: number; headY: number; pitch: number; yaw: number; rot: number;
    swayX: number; swayY: number; scale: number; scaleX: number; scaleY: number; scaleZ: number;
    face: string;
  }[] {
    const out = [];
    for (const slot of this.slots.values()) {
      if (!slot.built || !slot.holder || !slot.life) continue;
      const h = slot.built.head;
      out.push({
        key: slot.key,
        headX: h.position.x, headY: h.position.y - h.userData.restY,
        pitch: h.rotation.x, yaw: h.rotation.y, rot: h.rotation.z,
        swayX: slot.holder.position.x, swayY: slot.holder.position.y,
        scale: slot.scale,
        scaleX: slot.holder.scale.x, scaleY: slot.holder.scale.y, scaleZ: slot.holder.scale.z,
        face: slot.life.face(),
      });
    }
    return out;
  }

  /** Free everything. After this the stage is inert and a second call is a no-op. */
  dispose(): void {
    if (this.disposed) return;
    for (const slot of this.slots.values()) this.release(slot);
    this.slots.clear();
    this.queue = [];
    this.builtListeners.clear();
    this.renderer.dispose();
    this.disposed = true;
  }
}

/** `devicePixelRatio`, or a sane default where there is no window. Keeps the suite out of a browser. */
function devicePixelRatioOr(fallback: number): number {
  return typeof devicePixelRatio === "number" ? devicePixelRatio : fallback;
}

/** A monotonic clock, or `Date.now` where there is not one. Same reason. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

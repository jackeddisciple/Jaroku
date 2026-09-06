// The shapes the vendored gloss runtime hands back, written out so a `.ts` call site has something
// to hold.
//
// NOT UPSTREAM, AND NOT THE RECIPE EITHER. The `.js` files beside this one are copied verbatim from
// kindergrimm (see PROVENANCE.md) and this package has `allowJs` off, so each vendored module gets a
// hand-written `.d.ts` and they all reach here for the types they share. `recipe.ts` is a different
// file for a different job: it types what the ROSTER commits, which is data this repository owns and
// tests. This types what the RENDERER returns, which is somebody else's object graph described from
// the outside.
//
// DESCRIBED FROM THE OUTSIDE IS THE RULE. Everything Three.js owns is `unknown` rather than a
// hand-copied `Object3D`: a structural type for a class this repository does not compile is a type
// that goes quietly wrong the first time the pinned build moves, and the only honest thing to say
// about a `THREE.Mesh` here is that it is not ours. What IS spelled out is the handful of members
// the host actually touches — a position, a rotation, a rest offset, a geometry that can be
// disposed — because those are the ones a mistake would be silent in.

/** `(finish, colour, isShell, print) → a Three.js material`, cached by the factory that made it. */
export type MaterialFor = (
  finish: string,
  color: string,
  shell?: boolean,
  print?: unknown,
) => unknown;

/** Enough of a Three.js `Vector3` / `Euler` for what the host writes to one. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

/** Enough of a `Object3D` for the disposal walk `clearSlot` does. */
export interface DisposableNode {
  geometry?: { dispose(): void };
  material?: unknown;
}

/**
 * A recipe as the gloss runtime holds it, which is looser than `GlossRecipe` in `recipe.ts`.
 *
 * `ensureGParams` fills every null in place and hangs the per-feature parameters off `parts`.
 * Nothing above this layer reads `parts` — it is derived from `seed`, which is why the roster
 * commits a seed and five axes rather than a bag of numbers nobody could review.
 */
export interface GlossRecipeObject {
  seed: number;
  species: string | null;
  body: string | null;
  stance: string | null;
  palette: string | null;
  colorIx: number | null;
  material: string | null;
  parts: Record<string, unknown>;
}

/**
 * What `buildGloss` returns.
 *
 * `group` is the whole character. `head` is its own sub-group pivoted at the head's centre, and the
 * distinction is load-bearing: the gaze turns the HEAD so a character with a torso keeps its feet
 * planted, which is the one thing upstream's `animate()` is most easily got wrong.
 *
 * `bounds` is the REAL extent — ears, horns and a dropped maw included. `L.H` is the body's height
 * alone, and a host that fits a character by `L.H` grows the long-eared ones out of their box.
 */
export interface BuiltGloss {
  group: {
    position: Vec3Like;
    scale: Vec3Like;
    traverse(visit: (node: DisposableNode) => void): void;
  };
  head: { position: Vec3Like; rotation: Vec3Like; userData: { restY: number } };
  /** Feature id → its mesh. The animator owns every write to these. */
  face: Record<string, unknown>;
  P: Record<string, unknown>;
  /** The layout the parts agreed on. `H` is the body's height, `cy` its centre, `s` one unit. */
  L: { H: number; cy: number; s: number };
  bounds: { w: number; h: number; cy: number; minY: number; maxY: number };
  stats: { buildMs: number; verts: number; meshes: number };
}

/** The head offset an animator leaves behind for the host to apply. Character units, radians. */
export interface HeadOffset {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
  rot: number;
}

/**
 * The autonomic life: blink, gaze with saccades, the head whipping after the gaze, and idle.
 *
 * Breath and sway are NOT in here. Upstream keeps them in the page harness that was not copied —
 * fifteen lines inside `gcrowd.js`'s `animate()` — so they live in `GlossStage.ts` instead, ported
 * deliberately rather than lost. See §2.4 of the brief and the note on `GlossStage.animateSlot`.
 */
export interface GlossFaceLife {
  head: HeadOffset;
  face(): string;
  setFace(id: string): void;
  update(t: number, dt: number): HeadOffset;
}

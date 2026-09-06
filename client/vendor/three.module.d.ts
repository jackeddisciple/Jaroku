// The sliver of Three.js `GlossStage` touches, and nothing else.
//
// NOT UPSTREAM AND NOT COMPLETE, on purpose. `three.module.js` beside this file is the pinned build
// (see `src/lib/gloss/PROVENANCE.md`); the npm `three` package is deliberately absent, so its
// `@types` are absent too, and this is what lets a `.ts` call site hold a renderer.
//
// IT DESCRIBES USE, NOT THE LIBRARY. Every member below is one this repository actually calls, which
// keeps it short enough to read and — more usefully — makes the surface visible: if this file grows,
// the stage has reached further into somebody else's object graph than it should have. The vendored
// `.js` modules import Three.js too and are not typechecked at all (`allowJs` is off), so this is
// the only place the boundary is written down.
//
// A note on `dispose`. Three.js frees GPU resources through explicit `dispose()` on geometries,
// materials, textures and the renderer — nothing is reference-counted and nothing is collected — so
// those methods are declared even where nothing but the teardown path calls them. `test:gloss-stage`
// asserts a hundred mount/unmount cycles leave no geometry alive, and that assertion is only
// meaningful because these are here to be called.

export class Vector2 {
  constructor(x?: number, y?: number);
  x: number;
  y: number;
  set(x: number, y: number): this;
}

export class Vector3 {
  constructor(x?: number, y?: number, z?: number);
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
  copy(v: Vector3): this;
}

export class Euler {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
}

export class Color {
  constructor(color?: string | number);
  set(color: string | number): this;
}

export interface Disposable {
  dispose(): void;
}

export class Object3D {
  position: Vector3;
  rotation: Euler;
  scale: Vector3;
  visible: boolean;
  userData: Record<string, unknown>;
  children: Object3D[];
  geometry?: Disposable;
  material?: Disposable | Disposable[];
  add(...objects: Object3D[]): this;
  remove(...objects: Object3D[]): this;
  traverse(callback: (object: Object3D) => void): void;
  updateMatrixWorld(force?: boolean): void;
}

export class Group extends Object3D {}

export class Scene extends Object3D {
  background: Color | null;
  environment: unknown;
}

export class PerspectiveCamera extends Object3D {
  constructor(fov?: number, aspect?: number, near?: number, far?: number);
  aspect: number;
  updateProjectionMatrix(): void;
  lookAt(x: number, y: number, z: number): void;
}

export class ShadowMaterial implements Disposable {
  constructor(parameters?: { opacity?: number; transparent?: boolean });
  opacity: number;
  dispose(): void;
}

export class WebGLRenderer {
  constructor(parameters?: {
    canvas?: unknown;
    antialias?: boolean;
    alpha?: boolean;
    powerPreference?: "default" | "high-performance" | "low-power";
  });
  domElement: HTMLCanvasElement;
  shadowMap: { enabled: boolean; type: unknown; autoUpdate: boolean; needsUpdate: boolean };
  toneMapping: unknown;
  toneMappingExposure: number;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  setScissorTest(enabled: boolean): void;
  setClearAlpha(alpha: number): void;
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  setAnimationLoop(callback: ((time: number) => void) | null): void;
  dispose(): void;
  forceContextLoss(): void;
}

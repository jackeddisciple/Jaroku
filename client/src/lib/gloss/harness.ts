// What the three gloss suites need in order to run the REAL renderer path without a browser.
//
// NOT A TEST FRAMEWORK. The client's suites are plain `tsx` scripts on purpose — "what runs in CI is
// what a developer runs locally, spelled the same way" — and this is the shared setup, in the same
// spirit as `lib/icons/harness.ts` one directory over.
//
// TWO THINGS ARE FAKED AND ONE IMPORTANT THING IS NOT.
//
//   THE RENDERER is faked because a real `WebGLRenderer` needs a GL context. Every method the stage
//   calls is here and does nothing; what the suites read off it is how many were CONSTRUCTED.
//
//   `document.createElement("canvas")` is faked because `clothPrint` bakes a screen-printed torso
//   motif into a 2D canvas, and about a third of the roster is a dressed humanoid. The shim draws
//   nothing: no assertion anywhere has a pixel in it.
//
//   `buildGloss` IS REAL. Geometries are plain objects and construct fine with no context, so the
//   leak assertion and the animation assertions run against the code that ships. Faking the renderer
//   proves the stage builds one of them; faking the builder would have proved nothing at all.

import type { StageBindings } from "./GlossStage.ts";

/** A 2D context whose every method is a no-op, and the canvas that owns it. */
function canvasStub(): unknown {
  const ctx: Record<string, unknown> = {};
  for (const name of [
    "fillRect", "beginPath", "moveTo", "lineTo", "arc", "closePath", "fill", "stroke",
    "bezierCurveTo", "quadraticCurveTo", "drawImage", "putImageData", "createLinearGradient",
    "getImageData", "save", "restore", "translate", "rotate", "scale",
  ]) ctx[name] = () => undefined;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx["canvas"] = canvas;
  return canvas;
}

/**
 * Put just enough of a browser on `globalThis`.
 *
 * `??=` so a suite that has already installed a richer fake keeps it, and so calling this twice is
 * harmless. Nothing here is restored afterwards: these are one-shot scripts, and a teardown that
 * only ever runs at exit is a teardown nobody should have to read.
 */
export function installBrowserStubs(): void {
  const g = globalThis as { document?: unknown };
  g.document ??= { createElement: () => canvasStub() };
}

/** How many renderers have been constructed through `stageBindings`, since the last reset. */
export let renderersConstructed = 0;
/** How many have been disposed. */
export let renderersDisposed = 0;

export function resetRendererCounts(): void {
  renderersConstructed = 0;
  renderersDisposed = 0;
}

/**
 * Bindings that count contexts and build real characters.
 *
 * `canvas` is the size of the canvas the stage believes it is drawing into; slot rects are measured
 * against it, so it decides what counts as on screen.
 */
export function stageBindings(
  canvas = { width: 800, height: 600 },
  /** Called on every `renderer.render`, for suites that count DRAWS rather than frames. */
  onRender?: () => void,
): StageBindings {
  return {
    createRenderer: () => {
      renderersConstructed++;
      return {
        domElement: {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
        },
        setPixelRatio: () => undefined,
        setSize: () => undefined,
        setViewport: () => undefined,
        setScissor: () => undefined,
        setScissorTest: () => undefined,
        setClearAlpha: () => undefined,
        clear: () => undefined,
        render: () => onRender?.(),
        dispose: () => { renderersDisposed++; },
      } as unknown as ReturnType<StageBindings["createRenderer"]>;
    },
    // A material is a bag the mesh holds, and nothing above this line looks inside it.
    makeMaterialFor: () => () => ({ dispose: () => undefined }),
    // The studio prefilters its environment on the GPU. Nothing below it needs one.
    dress: () => undefined,
  };
}

/** A card's avatar box at a given offset, square, and on screen by default. */
export function box(top: number, left = 8, side = 96): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left, top, width: side, height: side }),
  } as unknown as HTMLElement;
}

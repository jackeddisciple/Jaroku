// §8's `test:gloss-stage`: exactly one WebGL context is ever constructed, and a hundred mount /
// unmount cycles leave no geometry retained.
//
// I1 IS THE INVARIANT EVERYTHING ELSE HANGS OFF, and it is the one that cannot be caught by looking.
// Browsers cap live WebGL contexts at roughly eight to sixteen and silently kill the OLDEST past
// that — no exception, no console message, just a canvas that stops painting. So a per-card canvas
// build works perfectly on the four-agent workspace a developer has open and produces cards that go
// blank at random on the twenty-agent one a customer has, which is a bug report nobody can reproduce.
// Counting constructions is the only way to assert it.
//
// AND HALF THE SUITE IS A SOURCE SCAN, deliberately. Counting what `GlossStage` builds proves the
// stage makes one; it says nothing about the component somebody adds next year that makes its own.
// The scan is what holds the invariant across the whole client, and it is the half that would
// actually fail.
//
// WHAT IS FAKED AND WHAT IS NOT. The renderer is faked because a real one needs a GL context and
// this runs in Node. `buildGloss` is REAL: geometries are plain objects that construct fine without
// a context, so the leak assertion runs against the code that ships. Faking the renderer proves the
// stage builds one; faking the builder would have proved nothing about geometry at all.
//
//   npm run test:gloss-stage

import { readdirSync, readFileSync } from "node:fs";

import { GlossStage, type StageBindings } from "./GlossStage.ts";
import { GLOSS_ROSTER } from "./roster.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- a browser, in the two respects the vendored code needs one ---------------------------------
//
// `clothPrint` bakes a screen-printed torso motif into a canvas, so a dressed humanoid reaches for
// `document`. The shim records nothing and draws nothing: this suite is about how many contexts
// exist and how much geometry is alive, and neither question has a pixel in it.

const canvasStub = (): unknown => {
  const ctx: Record<string, unknown> = { canvas: null };
  for (const name of [
    "fillRect", "beginPath", "moveTo", "lineTo", "arc", "closePath", "fill", "stroke",
    "bezierCurveTo", "quadraticCurveTo", "drawImage", "putImageData",
  ]) ctx[name] = () => undefined;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx["canvas"] = canvas;
  return canvas;
};
(globalThis as { document?: unknown }).document ??= { createElement: () => canvasStub() };

// --- the fake renderer, which is the thing being counted -----------------------------------------

let renderersConstructed = 0;
let rendererDisposed = 0;

function bindings(): StageBindings {
  return {
    createRenderer: () => {
      renderersConstructed++;
      const el = {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      };
      return {
        domElement: el,
        setPixelRatio: () => undefined,
        setSize: () => undefined,
        setViewport: () => undefined,
        setScissor: () => undefined,
        setScissorTest: () => undefined,
        setClearAlpha: () => undefined,
        clear: () => undefined,
        render: () => undefined,
        dispose: () => { rendererDisposed++; },
      } as unknown as ReturnType<StageBindings["createRenderer"]>;
    },
    // A material is a bag the mesh holds and nothing here looks inside it.
    makeMaterialFor: () => () => ({ dispose: () => undefined }),
    // The studio needs a GL context to prefilter its environment. Nothing below it does.
    dress: () => undefined,
  };
}

/** A card's avatar box, at a position that is on screen. */
const boxAt = (top: number): HTMLElement =>
  ({ getBoundingClientRect: () => ({ left: 8, top, width: 96, height: 96 }) }) as unknown as HTMLElement;

// --- 1. exactly one context, whatever the grid does ----------------------------------------------

console.log("\none WebGLRenderer, ever");
{
  renderersConstructed = 0;
  const stage = new GlossStage(bindings());
  check("constructing the stage constructs one renderer", renderersConstructed === 1,
    `${renderersConstructed}`);

  for (let i = 0; i < 20; i++) stage.mount(`a${i}`, boxAt(i * 100), GLOSS_ROSTER[i % GLOSS_ROSTER.length]!.id);
  stage.measure();
  for (let i = 0; i < 30; i++) stage.frame(i / 30, 1 / 30);
  check("twenty mounts and thirty frames construct no more", renderersConstructed === 1,
    `${renderersConstructed}`);

  for (let i = 0; i < 20; i++) stage.unmount(`a${i}`);
  stage.dispose();
  check("disposing releases the context", rendererDisposed === 1, `${rendererDisposed}`);
  check("a second dispose is a no-op", (stage.dispose(), rendererDisposed === 1), `${rendererDisposed}`);
}

// --- 2. and nothing else in the client constructs one --------------------------------------------

console.log("\nnothing else reaches for a context");
{
  // THE HALF THAT WOULD ACTUALLY FAIL. The counter above proves this stage behaves; this proves
  // nobody has added a second one — a per-card canvas, a thumbnail renderer, a preview in a modal.
  // Each of those looks reasonable on its own and each one costs a context out of a budget of eight.
  const files = readdirSync("src", { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `src/${f}`)
    .filter((f) => !f.endsWith("stage.test.ts"));
  const constructor = `new ${["THREE.WebGL", "Renderer"].join("")}`;
  const offenders = files.filter(
    (f) => readFileSync(f, "utf8").includes(constructor) && !f.endsWith("GlossStage.ts"),
  );
  check("only GlossStage.ts constructs a renderer", offenders.length === 0, offenders.join(", "));
}

// --- 3. a hundred mount/unmount cycles retain nothing ---------------------------------------------

console.log("\na hundred cycles leave nothing behind");
{
  const stage = new GlossStage(bindings());
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    const avatar = GLOSS_ROSTER[i % GLOSS_ROSTER.length]!.id;
    stage.mount(`row-${i}`, boxAt(20), avatar);
    stage.measure();
    // Enough frames to drain the build budget for this one slot.
    for (let f = 0; f < 4; f++) stage.frame(f / 30, 1 / 30);
    peak = Math.max(peak, stage.geometryCount);
    stage.unmount(`row-${i}`);
  }
  // THE GUARD ON THE GUARD. If the characters never built, "no geometry retained" is trivially true
  // and the suite is asserting nothing — which is exactly how a leak test goes quietly green.
  check("characters were actually built", peak > 0, `peak ${peak}`);
  check("after a hundred cycles nothing is retained",
    stage.geometryCount === 0 && stage.builtCount === 0,
    `${stage.geometryCount} geometries, ${stage.builtCount} built`);
  check("no slots are left registered", stage.size === 0, `${stage.size}`);
  stage.dispose();
}

// --- 4. every animation §11.5 names is actually wired ---------------------------------------------

console.log("\nblink, gaze, breath and sway all reach the character");
{
  // §2.4 IS RIGHT THAT THIS IS THE PART MOST EASILY LOST, and it is lost SILENTLY: a stage that
  // builds characters and never animates them renders a perfectly correct still grid, which looks
  // like a design decision rather than a bug. Blink, gaze and the saccade live in the vendored
  // `gface.js`; breath and sway were re-typed from the page harness that was not copied. All four
  // have to be observable from outside, so this reads the transforms the stage writes.
  const stage = new GlossStage(bindings());
  const rows = ["one", "two", "three", "four"];
  rows.forEach((k, i) => stage.mount(k, boxAt(20 + i * 120), GLOSS_ROSTER[i]!.id));
  stage.measure();
  for (let f = 0; f < 8; f++) stage.frame(f / 30, 1 / 30);

  // SAMPLED ACROSS THE WHOLE WINDOW, NOT AT TWO ENDPOINTS, and the difference is the difference
  // between a suite that passes and one that is flaky. A gaze is stochastic and most real glances
  // are EYES-ONLY — upstream sets `headFollow` to 1 less than half the time — so a character can
  // sit through a ten-second window with its head at rest and be working perfectly. Two endpoints
  // caught three of four slots and would have caught a different three next run.
  //
  // So: run a long clock and record the furthest each slot's head and holder ever get from rest.
  // Over ninety seconds a slot takes tens of glances, and the chance that none of them turns the
  // head is about one in a hundred million.
  const reach = new Map<string, { head: number; sway: number; breath: number }>();
  const observe = (): void => {
    for (const s of stage.debugTransforms()) {
      const at = reach.get(s.key) ?? { head: 0, sway: 0, breath: 0 };
      at.head = Math.max(at.head, Math.abs(s.headX), Math.abs(s.headY),
                         Math.abs(s.pitch), Math.abs(s.yaw), Math.abs(s.rot));
      at.sway = Math.max(at.sway, Math.abs(s.swayX), Math.abs(s.swayY));
      at.breath = Math.max(at.breath, Math.abs(s.scaleY / s.scale - 1));
      reach.set(s.key, at);
    }
  };

  check("every slot built", stage.debugTransforms().length === rows.length,
    `${stage.debugTransforms().length}`);
  for (let f = 0; f < 2700; f++) { stage.frame(f / 30, 1 / 30); observe(); }

  const still = [...reach].filter(([, v]) => v.head === 0).map(([k]) => k);
  check("the head moves on every slot — gaze, and the head whipping after it", still.length === 0,
    still.join(", "));
  const rigid = [...reach].filter(([, v]) => v.sway === 0 || v.breath === 0).map(([k]) => k);
  check("every slot breathes and sways", rigid.length === 0, rigid.join(", "));

  // THE BREATH IS VOLUME-PRESERVING, which is what makes it read as weight rather than as the
  // character inflating. y × sy against x and z ÷ √sy, so the product of the three is constant —
  // asserted rather than eyeballed, because the wrong version (scale y, leave x and z) looks fine
  // in a still and looks like a bicycle pump in motion.
  const volumes = stage.debugTransforms().map((s) => (s.scaleX * s.scaleY * s.scaleZ) / s.scale ** 3);
  check("the breath preserves volume", volumes.every((v) => Math.abs(v - 1) < 1e-9),
    volumes.map((v) => v.toFixed(9)).join(", "));

  // §2.4: "Every slot needs its own rate and phase. Without them twenty agents blink in perfect
  // unison, which is unsettling in a way people notice before they can say why." Four characters
  // mounted in the same frame is exactly the case that goes wrong, and the sway is where it shows:
  // breath and sway are pure functions of the slot's own clock, so identical values across four
  // slots means one clock.
  const inStep = new Set(stage.debugTransforms().map((s) => `${s.swayX},${s.swayY},${s.scaleY}`));
  check("no two slots are in step", inStep.size === rows.length, `${inStep.size}/${rows.length}`);
  stage.dispose();
}

// --- 5. an unknown avatar draws nothing ------------------------------------------------------------

console.log("\nan id the roster does not have");
{
  // NOT A FALLBACK CHARACTER. The whole promise of the roster is that an avatar identifies an agent,
  // and quietly substituting a default is two agents wearing one identity with nothing to say so.
  // It also must not throw: an id can outlive its entry if somebody edits the roster.
  const stage = new GlossStage(bindings());
  stage.mount("ghost", boxAt(20), "no-such-avatar");
  stage.measure();
  for (let f = 0; f < 4; f++) stage.frame(f / 30, 1 / 30);
  check("it builds nothing and does not throw", stage.builtCount === 0, `${stage.builtCount}`);
  stage.dispose();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

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

import { GlossStage } from "./GlossStage.ts";
import {
  box, installBrowserStubs, renderersConstructed, renderersDisposed, resetRendererCounts,
  stageBindings,
} from "./harness.ts";
import { GLOSS_ROSTER } from "./roster.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// The renderer is counted and the browser is stubbed in `harness.ts`; `buildGloss` stays real.

installBrowserStubs();

// --- 1. exactly one context, whatever the grid does ----------------------------------------------

console.log("\none WebGLRenderer, ever");
{
  resetRendererCounts();
  const stage = new GlossStage(stageBindings());
  check("constructing the stage constructs one renderer", renderersConstructed === 1,
    `${renderersConstructed}`);

  for (let i = 0; i < 20; i++) stage.mount(`a${i}`, box(i * 100), GLOSS_ROSTER[i % GLOSS_ROSTER.length]!.id);
  stage.measure();
  for (let i = 0; i < 30; i++) stage.frame(i / 30, 1 / 30);
  check("twenty mounts and thirty frames construct no more", renderersConstructed === 1,
    `${renderersConstructed}`);

  for (let i = 0; i < 20; i++) stage.unmount(`a${i}`);
  stage.dispose();
  check("disposing releases the context", renderersDisposed === 1, `${renderersDisposed}`);
  check("a second dispose is a no-op", (stage.dispose(), renderersDisposed === 1), `${renderersDisposed}`);
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
  const stage = new GlossStage(stageBindings());
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    const avatar = GLOSS_ROSTER[i % GLOSS_ROSTER.length]!.id;
    stage.mount(`row-${i}`, box(20), avatar);
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
  const stage = new GlossStage(stageBindings());
  const rows = ["one", "two", "three", "four"];
  rows.forEach((k, i) => stage.mount(k, box(20 + i * 120), GLOSS_ROSTER[i]!.id));
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

// --- 5. the head follows the pointer inside its card -----------------------------------------------

console.log("\nthe head turns toward the pointer while it is on the card");
{
  // TWO THINGS GO WRONG SILENTLY HERE. A head that never tracks looks like a head with its own life,
  // which is what it has the rest of the time — so the feature simply appears not to exist. And a
  // head that SNAPS between its own gaze and the pointer reads as a glitch rather than as attention,
  // which is why the hand-off is a weight that moves rather than a branch.
  const stage = new GlossStage(stageBindings({ width: 800, height: 600 }));

  // A card, and the avatar box inside it. The stage tracks the pointer against the CARD, because a
  // 64px box inside a 320px card is a target nobody would find.
  const card = { left: 100, top: 100, width: 300, height: 200 };
  const region = { getBoundingClientRect: () => card } as unknown as HTMLElement;
  stage.mount("hovered", box(120, 140), GLOSS_ROSTER[0]!.id, region);
  stage.mount("elsewhere", box(400), GLOSS_ROSTER[1]!.id, region2());
  stage.measure();
  for (let f = 0; f < 6; f++) stage.frame(f / 30, 1 / 30);

  const yawOf = (key: string): number =>
    stage.debugTransforms().find((s) => s.key === key)?.yaw ?? 0;

  // POINTER AT THE RIGHT EDGE OF THE CARD. Held there for a second of clock, which is long enough
  // for the follow to arrive and short enough that a random gaze could not account for it.
  stage.setPointer({ x: card.left + card.width - 1, y: card.top + card.height / 2 });
  for (let f = 0; f < 60; f++) stage.frame(10 + f / 60, 1 / 60);
  const right = yawOf("hovered");

  stage.setPointer({ x: card.left + 1, y: card.top + card.height / 2 });
  for (let f = 0; f < 60; f++) stage.frame(20 + f / 60, 1 / 60);
  const left = yawOf("hovered");

  check("it turns one way at one edge and the other way at the other", right * left < 0,
    `${right.toFixed(3)} vs ${left.toFixed(3)}`);
  // FAR ENOUGH TO BE NOTICED, WHICH IS THE WHOLE POINT OF IT. This assertion started at 0.15 and the
  // movement was still reported as "very slight" on a 64px card, because the range it was bounded by
  // was `gface.js`'s AMBIENT one — a glance that happens whether or not anybody is watching. A
  // response to a cursor has the opposite job. The floor is now most of the way to the maximum,
  // because what goes wrong here is a follow too small to see rather than one too large.
  check("...far enough to be noticed", Math.abs(right) > 0.45 && Math.abs(left) > 0.45,
    `${right.toFixed(3)} / ${left.toFixed(3)}`);
  // AND STILL BOUNDED. The corners of a card are the furthest it ever goes; past about forty degrees
  // a chibi head turns off its own face and the follow stops reading as attention.
  check("...and still bounded at the corners",
    Math.abs(right) <= 0.65 && Math.abs(left) <= 0.65, `${right.toFixed(3)} / ${left.toFixed(3)}`);

  // A CARD THE POINTER IS NOT ON IS UNAFFECTED. Twenty-four heads turning together would be a
  // novelty; one turning is attention.
  const otherWhileHovering = stage.debugTransforms().find((s) => s.key === "elsewhere");
  check("a card the pointer is not on keeps its own gaze",
    Math.abs(otherWhileHovering?.yaw ?? 0) <= 0.35, `${otherWhileHovering?.yaw.toFixed(3)}`);

  // AND IT LETS GO. Slower than it follows, so the character hands control back to its own life
  // rather than dropping it.
  stage.setPointer(null);
  for (let f = 0; f < 180; f++) stage.frame(30 + f / 60, 1 / 60);
  const released = stage.debugTransforms().find((s) => s.key === "hovered");
  check("the pointer's hold decays once it leaves", Math.abs(released?.yaw ?? 0) < Math.abs(left),
    `${released?.yaw.toFixed(3)} vs ${left.toFixed(3)}`);
  stage.dispose();
}

// --- 6. an unknown avatar draws nothing ------------------------------------------------------------

console.log("\nan id the roster does not have");
{
  // NOT A FALLBACK CHARACTER. The whole promise of the roster is that an avatar identifies an agent,
  // and quietly substituting a default is two agents wearing one identity with nothing to say so.
  // It also must not throw: an id can outlive its entry if somebody edits the roster.
  const stage = new GlossStage(stageBindings());
  stage.mount("ghost", box(20), "no-such-avatar");
  stage.measure();
  for (let f = 0; f < 4; f++) stage.frame(f / 30, 1 / 30);
  check("it builds nothing and does not throw", stage.builtCount === 0, `${stage.builtCount}`);
  stage.dispose();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

/** A second card, far from the first, for the "not this one" assertion. */
function region2(): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left: 500, top: 380, width: 300, height: 200 }),
  } as unknown as HTMLElement;
}

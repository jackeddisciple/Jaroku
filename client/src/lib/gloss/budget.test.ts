// §8's `test:gloss-budget`: the loop stops on blur, on tab change and under prefers-reduced-motion,
// and no more than the cap animate at once.
//
// EVERY ONE OF THESE IS INVISIBLE IN A SCREENSHOT, which is why they are asserted rather than looked
// at. A grid that keeps animating behind another window looks exactly like a grid that does not; the
// difference is a fan, a battery, and a laptop somebody closes the app on. The same is true of the
// cap: twenty animating slots and twelve animating slots are the same picture, and the machine that
// tells them apart is not the one this was built on.
//
// AND THE REDUCED-MOTION CASE IS THE ONE WORTH BEING PEDANTIC ABOUT. "Stops" must mean one frame and
// then nothing — not a slower animation, and not a blank card either. Both of those are easy to ship
// by accident and neither is what the setting asks for.
//
//   npm run test:gloss-budget

import {
  ANIMATING_CAP, GlossLoop, TARGET_FPS, decideBudget, type LoopEnvironment,
} from "./GlossBudget.ts";
import { GlossStage } from "./GlossStage.ts";
import { box, installBrowserStubs, stageBindings } from "./harness.ts";
import { GLOSS_ROSTER } from "./roster.ts";

// `clothPrint` bakes a torso motif into a 2D canvas, and a third of the roster is a dressed
// humanoid — so the loop cannot build a character without one. See `harness.ts`.
installBrowserStubs();

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const slot = (key: string, centreDistance: number, onScreen = true, built = true) =>
  ({ key, onScreen, built, centreDistance });

// --- 1. the three whole-loop stops -----------------------------------------------------------------

console.log("\nthe loop stops when there is nothing to say");
{
  const slots = [slot("a", 0), slot("b", 10), slot("c", 20)];
  const base = { active: true, focused: true, reducedMotion: false, slots };

  const running = decideBudget(base);
  check("it runs when the tab is up and the window is focused",
    running.animate && running.animating.size === 3, running.reason);

  // NOT THE ACTIVE SURFACE. The commonest case by far in a desktop app: it is open all day and the
  // Agents tab is not what it is open on.
  const inactive = decideBudget({ ...base, active: false });
  check("it stops when the Agents surface is not up",
    !inactive.animate && !inactive.drawOnce && inactive.animating.size === 0, inactive.reason);

  // BLURRED. A Tauri window behind another window is not a background tab and gets none of the
  // browser's own throttling, which is exactly why this rule is here rather than assumed.
  const blurred = decideBudget({ ...base, focused: false });
  check("it stops on window blur",
    !blurred.animate && !blurred.drawOnce && blurred.animating.size === 0, blurred.reason);

  // REDUCED MOTION. One frame, then stop — and note `drawOnce` is TRUE while `animate` is false.
  const still = decideBudget({ ...base, reducedMotion: true });
  check("reduced motion draws one frame and stops",
    !still.animate && still.drawOnce && still.animating.size === 0, still.reason);
  check("...and it is not merely a slower animation", still.animating.size === 0);

  // ORDER: a blurred window under reduced motion must not draw. The gates are cheapest-first and
  // `drawOnce` is the only one that produces work, so it must be the last thing reached.
  const both = decideBudget({ ...base, focused: false, reducedMotion: true });
  check("blur wins over reduced motion's one frame", !both.drawOnce, both.reason);
}

// --- 2. offscreen slots hold their last frame -------------------------------------------------------

console.log("\noffscreen slots hold still");
{
  const slots = [slot("on", 5), slot("off", 6, false), slot("unbuilt", 1, true, false)];
  const d = decideBudget({ active: true, focused: true, reducedMotion: false, slots });
  check("an offscreen slot does not animate", !d.animating.has("off"), [...d.animating].join(", "));
  // A SLOT WITH NO CHARACTER IS NOT AN ANIMATING SLOT, and it would otherwise take a place under the
  // cap from a card that has something to move — the cards nearest the centre are also the ones
  // built first, so the queue and the cap compete for the same seats.
  check("a slot with nothing built does not take a place", !d.animating.has("unbuilt"));
  check("the visible one does", d.animating.has("on"));
}

// --- 3. the cap, and which slots survive it ---------------------------------------------------------

console.log("\nno more than the cap animate at once");
{
  // Forty cards, all on screen, laid out so distance from centre is unambiguous.
  const many = Array.from({ length: 40 }, (_, i) => slot(`s${i}`, Math.abs(i - 20) * 10));
  const d = decideBudget({ active: true, focused: true, reducedMotion: false, slots: many });
  check(`at most ${ANIMATING_CAP} animate`, d.animating.size === ANIMATING_CAP, `${d.animating.size}`);

  // NEAREST THE CENTRE, which is what makes the freeze invisible: the eye is in the middle of the
  // grid, and a still card at the edge of your vision is not something anybody notices. Ranked by
  // mount order instead, the frozen ones would be wherever the list happened to end.
  const furthest = Math.max(
    ...many.filter((s) => d.animating.has(s.key)).map((s) => s.centreDistance),
  );
  const nearestFrozen = Math.min(
    ...many.filter((s) => !d.animating.has(s.key)).map((s) => s.centreDistance),
  );
  check("the ones that animate are the ones nearest the centre", furthest <= nearestFrozen,
    `${furthest} vs ${nearestFrozen}`);

  // STABLE UNDER A TIE, which every symmetric grid produces. Without the key tiebreak two cards at
  // equal distance swap places between frames and take turns freezing — a flicker that only appears
  // on a grid whose column count divides evenly, which is most of them.
  const tied = Array.from({ length: 20 }, (_, i) => slot(`t${i}`, 7));
  const first = decideBudget({ active: true, focused: true, reducedMotion: false, slots: tied });
  const again = decideBudget({ active: true, focused: true, reducedMotion: false, slots: [...tied].reverse() });
  check("ties resolve the same way every frame",
    [...first.animating].sort().join(",") === [...again.animating].sort().join(","));

  const under = decideBudget({
    active: true, focused: true, reducedMotion: false, slots: many.slice(0, 5),
  });
  check("under the cap, everything animates", under.animating.size === 5, `${under.animating.size}`);
}

// --- 4. the loop actually parks --------------------------------------------------------------------

console.log("\nthe loop asks for no frames when it is not drawing");
{
  // A DECISION THAT SAYS "STOP" IS NOT THE SAME AS A LOOP THAT STOPS. A driver that kept requesting
  // frames in order to decide not to draw would still wake the compositor thirty times a second, on
  // a window nobody is looking at — which is most of the cost this whole file exists to avoid.
  let focused = true;
  let reduced = false;
  let requested = 0;
  let pending: ((now: number) => void) | null = null;
  let listeners: (() => void)[] = [];
  let clock = 0;

  const env: LoopEnvironment = {
    focused: () => focused,
    reducedMotion: () => reduced,
    subscribe: (onChange) => { listeners.push(onChange); return () => { listeners = []; }; },
    requestFrame: (cb) => { requested++; pending = cb; return requested; },
    cancelFrame: () => { pending = null; },
    now: () => clock,
  };
  /** Run whatever the loop asked for, if it asked for anything. */
  const pump = (steps: number): number => {
    let ran = 0;
    for (let i = 0; i < steps; i++) {
      const next = pending;
      if (!next) break;
      pending = null;
      clock += 1000 / TARGET_FPS;
      next(clock);
      ran++;
    }
    return ran;
  };

  // The canvas the loop believes it is drawing into, so the four boxes below are on screen.
  const stage = new GlossStage(stageBindings({ width: 400, height: 400 }));
  const rows = ["k0", "k1", "k2", "k3"];
  rows.forEach((k, i) => stage.mount(k, box(10 + i * 100), GLOSS_ROSTER[i]!.id));

  const loop = new GlossLoop(stage, env);
  loop.start();
  check("it does not run before the surface is active", pump(5) <= 1 && loop.isParked,
    loop.lastDecision?.reason ?? "none");

  loop.setActive(true);
  check("it runs once the surface is active", pump(10) === 10 && !loop.isParked,
    loop.lastDecision?.reason ?? "none");

  focused = false;
  listeners.forEach((l) => l());
  pump(3);
  check("blur parks it", loop.isParked, loop.lastDecision?.reason ?? "none");
  check("...and no further frames are requested", pump(5) === 0);

  focused = true;
  listeners.forEach((l) => l());
  check("focus wakes it", pump(3) === 3 && !loop.isParked, loop.lastDecision?.reason ?? "none");

  loop.setActive(false);
  pump(2);
  check("leaving the Agents tab parks it", loop.isParked, loop.lastDecision?.reason ?? "none");
  check("...and nothing keeps ticking", pump(5) === 0);

  loop.setActive(true);
  // FOUR MORE, UNBUILT, so there is a queue when reduced motion comes on. Without this the earlier
  // frames have already drained everything and one frame is genuinely the right answer — which is
  // how the real bug hid: it only appears on a grid that is still filling in, which is every grid
  // for the first few hundred milliseconds and no grid a second later.
  ["k4", "k5", "k6", "k7"].forEach((k, i) => stage.mount(k, box(10 + i * 100), GLOSS_ROSTER[i + 4]!.id));
  reduced = true;
  listeners.forEach((l) => l());
  // FOUND BY LOOKING AT A REAL GRID. One frame drains one frame's worth of the build queue — about
  // two characters against the eight-millisecond budget — so parking after a single frame left
  // twenty-two of twenty-four cards showing an emoji placeholder for ever. It looked like a broken
  // queue and was a rule obeyed too literally: "no motion" cannot mean "most characters never
  // arrive". So frames keep being drawn until nothing is queued, and nothing moves in any of them.
  const drew = pump(40);
  check("reduced motion keeps drawing until the characters exist", drew > 1, `${drew} frame(s)`);
  check("...and nothing animates while it does", loop.lastDecision?.animating.size === 0,
    `${loop.lastDecision?.animating.size}`);
  check("...then parks", loop.isParked, loop.lastDecision?.reason ?? "none");
  check("...having drawn something", loop.lastDecision?.drawOnce === true);
  check("...and asks for no more frames", pump(5) === 0);
  check("...with every character built", stage.builtCount === 8, `${stage.builtCount}/8`);

  loop.stop();
  check("stop lets go of the listeners", listeners.length === 0, `${listeners.length}`);
  check("a stopped loop cannot be woken", (loop.wake(), pump(3) === 0));
  stage.dispose();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

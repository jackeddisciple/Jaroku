// I5, AND IT SHIPS WITH THE ENGINE RATHER THAN AFTER IT. A grid that melts a laptop for one release
// is a grid people turn off, and a feature people turn off does not get turned back on when it is
// fixed.
//
// FIVE RULES, AND EACH IS ABOUT A DIFFERENT WAY THIS COSTS SOMETHING:
//
//   NOT THE ACTIVE SURFACE — the Agents tab is not what is on screen. Nothing to draw, so nothing
//   is drawn. This is the one that matters most in practice, because a desktop app is open all day
//   and the Agents tab is not what it is open ON.
//
//   WINDOW BLURRED — the app is behind something else. The browser already throttles
//   `requestAnimationFrame` in a background tab, but a Tauri window that has lost focus is not a
//   background tab and gets no such help, and this is a desktop app.
//
//   REDUCED MOTION — one frame, then stop. NOT A SLOWER ANIMATION: §4.3 is explicit, and it is
//   right. Somebody who has asked the operating system for no motion has not asked for less of it,
//   and a gentle sway is exactly the kind of thing that triggers the vestibular symptoms the setting
//   exists for.
//
//   OFFSCREEN — a slot outside the canvas holds its last frame. Scroll a grid of forty and roughly
//   a dozen are visible; animating the rest is work whose entire output is discarded.
//
//   THE CAP — beyond a number of simultaneously animating slots, the ones nearest the centre keep
//   moving and the rest freeze. Ranking by distance rather than by mount order is what makes the
//   freeze invisible: the eye is at the middle of the grid, and a still card in the corner of your
//   vision is not something you notice.
//
// THE DECISION IS A PURE FUNCTION AND THE LOOP IS A THIN DRIVER, deliberately. Every rule above is a
// property somebody will want to change, and every one of them is unobservable in a screenshot — so
// they are asserted rather than looked at, and a pure function is what makes that possible without
// a browser.
//
//   npm run test:gloss-budget

import type { GlossStage } from "./GlossStage.ts";

/**
 * How many slots may animate at once. D2.
 *
 * TWELVE IS A STARTING POINT AND THE NUMBER IS RECORDED WITH THE MACHINE IT WAS MEASURED ON, because
 * a cap tuned on an M-series laptop is not a cap — it is a number that happens to be large enough
 * there. See `docs/avatars/decisions.md`.
 *
 * It is also roughly what fits: a three-across grid shows about nine cards in a window and about
 * twelve on a tall one, so at the default the cap is not doing anything until somebody scrolls fast
 * or opens the app full-screen on a large display. That is the right place for a limit to sit —
 * inactive in the ordinary case, and there for the one that would otherwise hurt.
 */
export const ANIMATING_CAP = 12;

/**
 * Frames per second the loop aims for.
 *
 * THIRTY, AS UPSTREAM, AND FOR ITS REASON: a page of idle faces blinking and glancing does not have
 * sixty things a second to say, and on a 120 Hz panel the uncapped version was rendering four times
 * as often as anything changed. That is heat, fan noise and battery for nothing.
 *
 * The animation is driven by the CLOCK rather than by the frame count — see `GlossStage.frame` — so
 * halving the frame rate changes the pace of nothing. It only stops drawing the same thing twice.
 */
export const TARGET_FPS = 30;

const MIN_FRAME_MS = 1000 / TARGET_FPS;

/**
 * How long after an interaction the loop draws at the display's full rate instead of at 30.
 *
 * THIRTY FRAMES A SECOND IS RIGHT FOR IDLE FACES AND WRONG FOR A SCROLL, and the difference shows
 * up in the worst possible way. The canvas does not scroll — it is inset to the pane and the cards
 * move under it — so a character is only in the right place on the frames the loop redraws. At 30
 * fps on a 120 Hz display that is one frame in four, and the other three show cards that have moved
 * and characters that have not: every avatar appears to float free of its card, drifting and
 * catching up, which is exactly what it was reported as.
 *
 * So a scroll, a resize, a mount or a pointer move opens a window in which the gate is off and every
 * animation frame is drawn. Two hundred milliseconds is long enough to cover the momentum after a
 * trackpad flick and short enough that an idle grid is back to 30 within a fifth of a second.
 *
 * It costs nothing when nothing is happening, which is the whole point: the expensive case is a grid
 * nobody is touching, and that one is untouched.
 */
const INTERACTIVE_MS = 200;

/** What the world looks like when the loop asks whether to run. */
export interface BudgetInputs {
  /** Is the Agents surface the one on screen? */
  active: boolean;
  /** Does the window have focus? */
  focused: boolean;
  /** Has the user asked the system for no motion? */
  reducedMotion: boolean;
  /** Every mounted slot, from the last measurement pass. */
  slots: readonly { key: string; onScreen: boolean; built: boolean; centreDistance: number }[];
  /**
   * Are there characters still waiting to be built?
   *
   * FOUND BY LOOKING AT IT. Reduced motion draws one frame and parks, and one frame drains one
   * frame's worth of the build queue — so a grid of twenty-four came up with two characters and
   * twenty-two emoji placeholders, and stayed that way. The setting asks for no MOTION; a grid that
   * mostly never renders is a different and worse thing, and it looked exactly like a bug in the
   * queue rather than like a rule being obeyed.
   */
  building?: boolean;
  cap?: number;
}

/** What the loop should do about it. */
export interface BudgetDecision {
  /** Keep stepping the clock. False means park until something changes. */
  animate: boolean;
  /**
   * Draw one frame anyway.
   *
   * REDUCED MOTION IS NOT "DRAW NOTHING". The characters still have to appear — a blank grid is not
   * an accessibility feature — so the loop renders the first frame and then stops, which is a still
   * portrait rather than an empty box. It is also true after a resize or a scroll while parked: the
   * canvas has to be repainted at the new rects even when nothing is moving.
   */
  drawOnce: boolean;
  /** The slots whose characters may move this frame. Everything else holds its last frame. */
  animating: ReadonlySet<string>;
  /** Why, for the suite and for anybody reading a log. */
  reason: "running" | "reduced-motion" | "blurred" | "inactive";
}

/**
 * Decide what may move.
 *
 * ORDER MATTERS AND THE CHEAPEST GATE IS FIRST. `inactive` and `blurred` are whole-loop stops, so
 * they short-circuit before anything is ranked; the cap is the only rule that has to look at every
 * slot, and it only runs when the loop is actually going to draw something that moves.
 */
export function decideBudget(inputs: BudgetInputs): BudgetDecision {
  const none: ReadonlySet<string> = new Set();
  // NOT ON SCREEN AT ALL. Nothing to draw and nothing to hold — a re-entry redraws from scratch.
  if (!inputs.active) return { animate: false, drawOnce: false, animating: none, reason: "inactive" };
  // BEHIND ANOTHER WINDOW. The grid stays painted, so nothing is redrawn either.
  if (!inputs.focused) return { animate: false, drawOnce: false, animating: none, reason: "blurred" };
  // ONE FRAME, THEN STOP — but "then" is after the characters exist. `drawOnce` keeps being true
  // while anything is still queued, so the grid FILLS IN and only then goes still. Nothing moves at
  // any point: `animating` is empty in both cases, so every frame drawn here is the same first frame
  // of every character. Not a slower animation, and not a half-empty grid either.
  if (inputs.reducedMotion) {
    return { animate: false, drawOnce: true, animating: none, reason: "reduced-motion" };
  }

  const cap = inputs.cap ?? ANIMATING_CAP;
  // NEAREST THE CENTRE FIRST. A stable sort on the key breaks ties, so two cards at equal distance —
  // which is every symmetric grid — do not swap between frames and take turns freezing.
  const eligible = inputs.slots
    .filter((s) => s.onScreen && s.built)
    .sort((a, b) => a.centreDistance - b.centreDistance || (a.key < b.key ? -1 : 1))
    .slice(0, Math.max(0, cap));
  return {
    animate: true,
    drawOnce: false,
    animating: new Set(eligible.map((s) => s.key)),
    reason: "running",
  };
}

/** The browser facts the loop watches. Injectable, so the suite is not a browser. */
export interface LoopEnvironment {
  focused(): boolean;
  reducedMotion(): boolean;
  /** Subscribe to anything that could change the answer. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}

/** The real one. Everything it reads is a browser global, which is why it is behind an interface. */
export function browserEnvironment(): LoopEnvironment {
  const query =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  return {
    // `document.hasFocus()` rather than a `focused` flag kept by hand: a window can lose focus
    // before any listener is attached, and a flag initialised to `true` would then run for ever
    // against a window nobody is looking at.
    focused: () => (typeof document === "undefined" ? true : document.hasFocus()),
    reducedMotion: () => query?.matches ?? false,
    subscribe: (onChange) => {
      const events: [EventTarget, string][] = [
        [window, "focus"], [window, "blur"], [window, "resize"], [document, "visibilitychange"],
      ];
      for (const [target, name] of events) target.addEventListener(name, onChange);
      // THE MEDIA QUERY IS A LIVE SUBSCRIPTION, not a value read at boot. Somebody turning reduced
      // motion on in System Settings expects the app in front of them to stop moving, not to stop
      // moving next time they open it.
      query?.addEventListener("change", onChange);
      return () => {
        for (const [target, name] of events) target.removeEventListener(name, onChange);
        query?.removeEventListener("change", onChange);
      };
    },
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    now: () => performance.now(),
  };
}

/**
 * Drives one stage, under the budget.
 *
 * IT OWNS WHEN, THE STAGE OWNS WHAT. Splitting them is what lets the throttle be tested without a
 * renderer and the renderer be tested without a clock, and it is also the honest description of the
 * two jobs: one is a policy about somebody's laptop, the other is a scissor pass.
 */
export class GlossLoop {
  private handle: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private active = false;
  private last = 0;
  private lastDraw = -Infinity;
  /** Until when every animation frame is drawn rather than one in every `MIN_FRAME_MS`. */
  private liveUntil = -Infinity;
  private parked = true;
  private stopped = false;
  /** The last decision, so a caller (and the suite) can see why nothing is moving. */
  lastDecision: BudgetDecision | null = null;

  constructor(
    private readonly stage: GlossStage,
    private readonly env: LoopEnvironment = browserEnvironment(),
    private readonly cap: number = ANIMATING_CAP,
  ) {}

  /** Start watching. The loop still will not run until `setActive(true)`. */
  start(): void {
    if (this.stopped || this.unsubscribe) return;
    this.unsubscribe = this.env.subscribe(() => this.wake());
    this.wake();
  }

  /** The Agents surface came into or went out of view. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.wake();
  }

  /**
   * Something changed — a scroll, a mount, a resize, a pointer move. Re-decide, and draw.
   *
   * IT ALSO OPENS THE INTERACTIVE WINDOW. Everything that calls this moves something under a canvas
   * that does not move with it, so for the next fraction of a second the frame gate comes off and
   * the characters stay attached to whatever is carrying them. See `INTERACTIVE_MS`.
   */
  wake(): void {
    if (this.stopped) return;
    this.liveUntil = this.env.now() + INTERACTIVE_MS;
    this.parked = false;
    if (this.handle === null) {
      this.last = this.env.now();
      this.handle = this.env.requestFrame((t) => this.tick(t));
    }
  }

  private decide(): BudgetDecision {
    return decideBudget({
      active: this.active,
      focused: this.env.focused(),
      reducedMotion: this.env.reducedMotion(),
      slots: this.stage.slotMetrics(),
      building: this.stage.pending > 0,
      cap: this.cap,
    });
  }

  private tick(now: number): void {
    this.handle = null;
    if (this.stopped) return;

    // MEASURE FIRST, ALWAYS, AND ONCE. Every rect read in the application happens on this line.
    this.stage.measure();
    const decision = this.decide();
    this.lastDecision = decision;

    if (!decision.animate && !decision.drawOnce) {
      // PARKED. No frame is requested, so the loop costs nothing at all until `wake` is called —
      // which is what a listener on focus, visibility or a scroll does. A loop that kept requesting
      // frames in order to decide not to draw would still be waking the compositor thirty times a
      // second to do nothing.
      this.parked = true;
      return;
    }

    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;

    // THE GATE IS HERE AND NOT INSIDE `stage.frame`, so a caller driving frames by hand still gets
    // every one it asks for. Gating the draw itself silently swallowed half of them upstream and
    // filled the sheet at half speed under test.
    // AND THE GATE IS OFF DURING AN INTERACTION. A scrolling grid redraws on every frame, because a
    // character repositioned on one frame in four visibly floats away from the card carrying it.
    const live = now < this.liveUntil;
    if (live || now - this.lastDraw >= MIN_FRAME_MS - 0.5) {
      this.lastDraw = now;
      this.stage.frame(now / 1000, dt, (key) => decision.animating.has(key));
    }

    if (decision.animate || (decision.drawOnce && this.stage.pending > 0)) {
      // THE SECOND CLAUSE IS THE REDUCED-MOTION FILL. A single frame builds about two characters
      // against the eight-millisecond budget, so parking after one leaves a grid of placeholders.
      // Frames keep being asked for until the queue is empty, and then it parks for good — the
      // whole sequence still moves nothing, because `animating` is empty throughout.
      this.handle = this.env.requestFrame((t) => this.tick(t));
    } else {
      // `drawOnce` with nothing left to build. One frame, and then nothing until something wakes it.
      this.parked = true;
    }
  }

  /** True when the loop has stopped requesting frames. The suite's "it stops" assertions read this. */
  get isParked(): boolean {
    return this.parked && this.handle === null;
  }

  /** Stop for good and let go of the listeners. The stage is the caller's to dispose. */
  stop(): void {
    this.stopped = true;
    this.parked = true;
    if (this.handle !== null) this.env.cancelFrame(this.handle);
    this.handle = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

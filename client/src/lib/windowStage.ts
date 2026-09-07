// Which of the two windows this launch needs, told to the shell that owns the frame.
//
// THE PRODUCT HAS TWO WINDOW SIZES AND ONLY THIS BUNDLE KNOWS WHICH ONE. The welcome screen is a
// small centred window — a mark, the product's name, one line, one button — and the application
// behind it is 1440 wide with three columns in it. Which of the two a launch opens into depends on
// whether there is a session, whether first-run is done and whether this launch has already been
// through the welcome screen, and every one of those facts lives here rather than in Rust.
//
// THE HALF THAT CANNOT BE DONE HERE is the frame itself: a webview cannot resize the native window
// it is inside, and it cannot lower the minimum size that stops the application being dragged
// below its own layout. So the page decides and the shell acts — `window.rs`, `set_window_stage`.
//
// AND THE WINDOW IS HIDDEN UNTIL THIS IS CALLED. That is the point of it. A window shown before
// the bundle has decided is a 1440×900 frame that snaps down to 560 a moment later, on every
// single launch, which is the flicker that reads as a broken application. The shell shows the
// window on the first stage it is told; if this is never called it shows it anyway after four
// seconds, so a bundle that fails to load cannot leave somebody with no window at all.
//
// THROUGH `__TAURI__.core.invoke` AND NOT `@tauri-apps/api`, the same shape as `windowTitle.ts`
// beside it: read the global, do nothing if it is absent, never import the package. In a browser
// there is no frame to size and every call here is a no-op.

/** The shape this module needs of the host bridge. See `sessionVault.ts` for the same shim. */
interface TauriBridge {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

function bridge(): TauriBridge | undefined {
  // `globalThis` rather than `window`, because every suite in this repository runs under tsx where
  // `window` is not defined and reading it throws at module load.
  const value = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * The two shapes this window has.
 *
 * `splash` is the welcome screen and nothing else. Everything else in the product — first-run,
 * sign-in, the name screen, onboarding, the app — is `app`, because all of them are views that
 * need room and none of them is the one screen the small window was cut for.
 */
export type WindowStage = "splash" | "app";

/** Whether this bundle is running inside a host that has a native window to size. */
export function hasHostWindow(): boolean {
  return bridge()?.core?.invoke !== undefined;
}

/**
 * Ask the shell for a stage. Idempotent, and deliberately so.
 *
 * IT REMEMBERS THE LAST ONE because the caller is a React effect and React will run it again — a
 * remount, a re-render with a changed dependency, StrictMode's deliberate double-invoke. Every one
 * of those would otherwise re-centre a window somebody had just dragged somewhere, which is a
 * window that will not stay where it is put.
 */
let last: WindowStage | null = null;

export function setWindowStage(stage: WindowStage): void {
  if (stage === last) return;
  const invoke = bridge()?.core?.invoke;
  if (!invoke) return;
  last = stage;
  // FAILURE IS SWALLOWED, as it is for the window title next door: the shell refusing to resize a
  // window is not something a person can act on, and raising over it would put an error in front
  // of somebody for the sake of a frame that is merely the wrong size.
  void invoke("set_window_stage", { stage }).catch(() => {
    // Forgotten rather than kept, so the next render tries again instead of believing a stage the
    // shell never applied.
    last = null;
  });
}

/** Test seam. The module-level memo is what makes a second call cheap; suites need it back. */
export function resetWindowStageForTests(): void {
  last = null;
}

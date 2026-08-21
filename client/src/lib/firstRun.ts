// What the shell is doing to set this machine up, as the page sees it.
//
// THE FOURTH MODULE IN THIS CLIENT THAT KNOWS A HOST MAY EXIST, after the session vault, the
// deep-link listener and the backend status. It is here rather than folded into `hostBackend.ts`
// — which is the closest of the three — because the two describe different things with different
// lifetimes and different audiences. A backend status is about a PROCESS and is true for the whole
// life of the app; this is about a MACHINE, is true once, and is the only one of the two that ever
// takes the whole screen.
//
// IT IS A NO-OP IN A BROWSER, like all three of the others: `onFirstRun` returns an unsubscribe
// that does nothing, `firstRunSnapshot` resolves to null, and `required` is therefore false
// forever — which is exactly right, because a browser has no `~/.jaroku` to set up and never did.
// So every reader's "no host has said anything" branch is the browser's permanent state and needs
// no `if` of its own. `npm run dev` in a tab is byte-for-byte unchanged.
//
// EVERY PAYLOAD IS VALIDATED, for the reason `hostBackend.ts` validates its own. The risk is not
// malice — the host is the application — it is a host that is WRONG: an older shell with a step id
// this build has never heard of, a field renamed on one side of a seam nothing typechecks. A
// progress that half-parses would put a setup screen with four blank rows over a working
// application, which is worse than not having the feature at all.
//
// AND THE SNAPSHOT EXISTS FOR THE SAME REASON `backend_status` DOES. The shell settles most of
// this during startup, which is before React has mounted anything, so a page that only subscribed
// would miss the whole sequence on precisely the launches it was written for. The screen asks once
// on mount and subscribes for the rest.

/** Must match `src-tauri/src/firstrun.rs`'s `EVENT`. */
const EVENT = "jaroku:first-run";

/** Must match `src-tauri/src/firstrun.rs`'s `STEPS`, in order. */
const STEP_IDS = ["storage", "python", "dependencies", "checkpoints"] as const;

/** Must match `src-tauri/src/firstrun.rs`'s `State`. */
const STATES = ["pending", "running", "done", "failed"] as const;

export type FirstRunStepId = (typeof STEP_IDS)[number];
export type FirstRunState = (typeof STATES)[number];

export interface FirstRunStep {
  id: FirstRunStepId;
  /** The row's name, from the shell. Not mapped here: two copies of four strings is one too many. */
  label: string;
  state: FirstRunState;
  /** One short line under the row, when there is one. Never a stack trace. */
  detail: string | null;
}

export interface FirstRunProgress {
  /**
   * Whether the page should show any of this AT ALL.
   *
   * FALSE ON EVERY LAUNCH AFTER THE FIRST. The shell decides it once, from the marker file, before
   * any step runs — the steps themselves happen on every launch, and a screen that appeared
   * because one was briefly in flight would greet a returning user with a setup flow for a machine
   * they set up months ago.
   */
  required: boolean;
  steps: FirstRunStep[];
  /** All four succeeded and the marker is on disk. §2.1's screen 3. */
  complete: boolean;
  /** The failure, when there is one. One sentence, safe to render. */
  message: string | null;
  /** Whether the failure looks like an absent network rather than a broken machine. §2.2. */
  offline: boolean;
  /** Where the shell wrote everything down. Offered, never printed — a log is not a UI. */
  logPath: string | null;
}

interface TauriBridge {
  event?: { listen(event: string, handler: (message: { payload: unknown }) => void): Promise<() => void> };
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

/** Reached through the global rather than through `@tauri-apps/api`, so that neither package.json
 *  nor a browser build gains a dependency for a feature only one host has. */
function bridge(): TauriBridge | undefined {
  return (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
}

/**
 * Read a progress the host sent, or answer `null`.
 *
 * `null` for every failure with one value, for the reason `parseDeepLink` gives: a caller that
 * distinguished "unknown step id" from "not an object" would do the same thing in both cases, and
 * that thing is to go on rendering what the page already knows.
 *
 * THE STEP LIST IS CHECKED AS A SET RATHER THAN AS A SEQUENCE OF NAMES IT RECOGNISES. A shell that
 * sends five steps, or four in a different order, or one this build has never heard of, is a shell
 * this build cannot render honestly — and half a setup screen is worse than none.
 */
export function parseFirstRun(raw: unknown): FirstRunProgress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.required !== "boolean") return null;
  if (!Array.isArray(value.steps) || value.steps.length !== STEP_IDS.length) return null;

  const steps: FirstRunStep[] = [];
  for (let i = 0; i < value.steps.length; i++) {
    const step = value.steps[i] as Record<string, unknown> | null;
    if (typeof step !== "object" || step === null) return null;
    // ORDER IS PART OF THE CONTRACT. §2.1 draws these four in a sequence that describes what is
    // actually happening — storage before Python before its dependencies — and a screen that
    // showed them shuffled would be describing a machine nobody is setting up.
    if (step.id !== STEP_IDS[i]) return null;
    if (typeof step.label !== "string" || step.label === "") return null;
    if (typeof step.state !== "string" || !(STATES as readonly string[]).includes(step.state)) return null;
    steps.push({
      id: STEP_IDS[i]!,
      label: step.label,
      state: step.state as FirstRunState,
      detail: typeof step.detail === "string" && step.detail !== "" ? step.detail : null,
    });
  }

  return {
    required: value.required,
    steps,
    complete: value.complete === true,
    message: typeof value.message === "string" && value.message !== "" ? value.message : null,
    offline: value.offline === true,
    logPath: typeof value.logPath === "string" && value.logPath !== "" ? value.logPath : null,
  };
}

/**
 * What the shell last said, or null.
 *
 * Null in a browser and null under a shell too old to answer, and the caller treats both the same
 * way: there is no first run, so render the app. That is the correct reading of both — a browser
 * has no machine to set up, and a shell that predates this feature has already written its marker
 * by whatever rule it had.
 */
export async function firstRunSnapshot(): Promise<FirstRunProgress | null> {
  const tauri = bridge();
  if (!tauri?.core?.invoke) return null;
  try {
    return parseFirstRun(await tauri.core.invoke("first_run_progress"));
  } catch {
    return null;
  }
}

/** Subscribe to progress. A no-op in a browser, returning a function that does nothing. */
export function onFirstRun(handler: (progress: FirstRunProgress) => void): () => void {
  const tauri = bridge();
  if (!tauri?.event?.listen) return () => {};

  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void tauri.event
    .listen(EVENT, (message) => {
      const progress = parseFirstRun(message.payload);
      if (progress) handler(progress);
      else console.warn("[jaroku] ignored a setup progress this build does not understand");
    })
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    })
    .catch(() => {
      /* no host, or a host that will not subscribe. The snapshot is the fallback. */
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * Run the four steps again, from the top. §2.3's Retry.
 *
 * Resolves with an error message the screen renders, or null when the retry started. It does NOT
 * resolve when the retry FINISHES — the progress events are what say that, and a promise that
 * waited would be a second way of knowing the same thing that could disagree with the first.
 */
export async function retryFirstRun(): Promise<string | null> {
  const tauri = bridge();
  if (!tauri?.core?.invoke) return "there is nothing to retry in a browser";
  try {
    await tauri.core.invoke("retry_first_run");
    return null;
  } catch (err) {
    return String((err as Error)?.message ?? err);
  }
}

/**
 * Close the application. §2.3's Quit.
 *
 * A COMMAND RATHER THAN `window.close()`, because the tray makes the close button hide the window
 * so a run in flight is not cancelled — right everywhere except here, where somebody who has just
 * been told the app cannot set itself up would be left with a tray icon and no window.
 *
 * `false` in a browser, where there is no application to quit and the honest answer is that this
 * did not happen. The caller's fallback is to leave the button out.
 */
export async function quitApp(): Promise<boolean> {
  const tauri = bridge();
  if (!tauri?.core?.invoke) return false;
  try {
    await tauri.core.invoke("quit_app");
    return true;
  } catch {
    return false;
  }
}

/** Which step is happening right now, or null. The one row that carries `stream-pulse`. */
export function activeStep(progress: FirstRunProgress): FirstRunStep | null {
  return progress.steps.find((s) => s.state === "running") ?? null;
}

/** The step that failed, or null. What the failure screen names. */
export function failedStep(progress: FirstRunProgress): FirstRunStep | null {
  return progress.steps.find((s) => s.state === "failed") ?? null;
}

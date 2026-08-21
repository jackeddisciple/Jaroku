// What a host may tell this bundle about setting the machine up.
//
// EVERY ASSERTION HERE IS A REFUSAL, and that is the shape this suite shares with `test:host-config`
// and `test:host-backend`. The risk is not malice — the host IS the application — it is a host that
// is WRONG: an older shell with a step this build has never heard of, a field renamed on one side
// of a seam nothing typechecks, four steps arriving in a different order. Each of those produces a
// setup screen with blank rows over an application that works perfectly, which is worse than not
// having the feature.
//
// AND THE ORDER IS PART OF THE CONTRACT, which is the least obvious assertion in the file. §2.1
// draws the four steps in a sequence that describes what actually happens — storage before Python
// before its dependencies — so a shell that sent them shuffled would be describing a machine nobody
// is setting up. Refused whole rather than sorted, because sorting them would mean this build
// deciding what the shell meant.
//
//   npm run test:auth-first-run

import { activeStep, failedStep, parseFirstRun, type FirstRunProgress } from "./firstRun.ts";
import { firstRunOnScreen } from "../store/firstRunStore.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

/** A progress exactly as `firstrun.rs` serialises one. Everything below is a mutation of this. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    required: true,
    steps: [
      { id: "storage", label: "App storage", state: "done", detail: "/home/ada/.jaroku" },
      { id: "python", label: "Python runtime", state: "done", detail: "Python 3.12.7 detected" },
      { id: "dependencies", label: "Runtime dependencies", state: "running", detail: "Prepared 12 packages" },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ],
    complete: false,
    message: null,
    offline: false,
    logPath: "/home/ada/.jaroku/logs/desktop.log",
    ...overrides,
  };
}

console.log("\nwhat a shell sends while it is working");
{
  const progress = parseFirstRun(payload());
  check("a well-formed progress parses", progress !== null);
  check("...with all four steps", progress?.steps.length === 4);
  check("...in the order §2.1 draws them", progress?.steps.map((s) => s.id).join(",") === "storage,python,dependencies,checkpoints");
  check("...carrying the shell's own labels rather than a second copy of them", progress?.steps[1]?.label === "Python runtime");
  check("the one running step is the one that is running", activeStep(progress!)?.id === "dependencies");
  check("...and nothing has failed", failedStep(progress!) === null);
  check("the log path comes through, for the failure screen to offer", progress?.logPath?.endsWith("logs/desktop.log") === true);
}
{
  // An empty detail is NOT a detail. The Rust side sends `null` for a step that has nothing to say
  // and this normalises the empty string to the same thing — otherwise a row renders a blank line
  // under it and the list jumps by one line height for no reason anybody can see.
  const progress = parseFirstRun(
    payload({ steps: [
      { id: "storage", label: "App storage", state: "running", detail: "" },
      { id: "python", label: "Python runtime", state: "pending", detail: null },
      { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ] }),
  );
  check("an empty detail is read as no detail", progress?.steps[0]?.detail === null);
}

console.log("\nthe two failures, which are different screens");
{
  const broken = parseFirstRun(
    payload({
      steps: [
        { id: "storage", label: "App storage", state: "done", detail: null },
        { id: "python", label: "Python runtime", state: "failed", detail: "the bundled interpreter would not start" },
        { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
        { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
      ],
      message: "the bundled interpreter would not start",
      offline: false,
    }),
  );
  check("a failed step is found by name", failedStep(broken!)?.id === "python");
  check("...and the message comes with it", broken?.message?.includes("would not start") === true);
  check("...and it is not an offline failure", broken?.offline === false);
}
{
  // §2.2: "Step 3 fails cleanly with a 'You're offline' screen, a retry button, and no scary error
  // messages." A FLAG rather than a message the client matches on — a client deciding that by
  // reading substrings out of uv's stderr shows the wrong screen the day uv rewords itself.
  const offline = parseFirstRun(
    payload({
      steps: [
        { id: "storage", label: "App storage", state: "done", detail: null },
        { id: "python", label: "Python runtime", state: "done", detail: null },
        { id: "dependencies", label: "Runtime dependencies", state: "failed", detail: null },
        { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
      ],
      message: "this step needs the internet, and there is none right now",
      offline: true,
    }),
  );
  check("an offline failure says so with a flag, not with prose", offline?.offline === true);
  check("...on the one step that needs a network", failedStep(offline!)?.id === "dependencies");
}

console.log("\nwhat this build refuses to render");
{
  check("nothing at all is refused", parseFirstRun(null) === null);
  check("a string is not a progress", parseFirstRun("preparing") === null);
  check("an array is not a progress", parseFirstRun([]) === null);
  check("a progress that does not say whether it is required is refused", parseFirstRun(payload({ required: undefined })) === null);
  check("...and one that says so with a string rather than a boolean", parseFirstRun(payload({ required: "yes" })) === null);
}
{
  // AN OLDER PAGE BESIDE A NEWER SHELL, which is a real configuration: the shell updates itself and
  // the bundle it serves comes from the same release, but a development build mixes them freely.
  const extra = payload();
  (extra.steps as unknown[]).push({ id: "telemetry", label: "Telemetry", state: "pending", detail: null });
  check("a fifth step this build has never heard of refuses the whole progress", parseFirstRun(extra) === null);

  const short = payload({ steps: (payload().steps as unknown[]).slice(0, 3) });
  check("...and so does a missing one", parseFirstRun(short) === null);
}
{
  const shuffled = payload({
    steps: [
      { id: "python", label: "Python runtime", state: "done", detail: null },
      { id: "storage", label: "App storage", state: "done", detail: null },
      { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ],
  });
  // Refused whole rather than sorted. Sorting would mean this build deciding what the shell meant.
  check("four steps in the wrong order are refused rather than sorted", parseFirstRun(shuffled) === null);
}
{
  const renamed = payload({
    steps: [
      { id: "storage", label: "App storage", state: "done", detail: null },
      { id: "interpreter", label: "Python runtime", state: "done", detail: null },
      { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ],
  });
  check("a step renamed on the Rust side alone is refused", parseFirstRun(renamed) === null);

  const unknownState = payload({
    steps: [
      { id: "storage", label: "App storage", state: "skipped", detail: null },
      { id: "python", label: "Python runtime", state: "pending", detail: null },
      { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ],
  });
  check("a state this build cannot draw is refused", parseFirstRun(unknownState) === null);

  const unlabelled = payload({
    steps: [
      { id: "storage", label: "", state: "done", detail: null },
      { id: "python", label: "Python runtime", state: "pending", detail: null },
      { id: "dependencies", label: "Runtime dependencies", state: "pending", detail: null },
      { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
    ],
  });
  check("a step with no name is refused, rather than rendering a blank row", parseFirstRun(unlabelled) === null);
}

console.log("\nwhen the screens are actually on screen");
{
  const running = parseFirstRun(payload())!;
  const done = parseFirstRun(payload({ required: false, complete: true }))!;

  // A BROWSER'S PERMANENT STATE, and also the first frame of every desktop launch. Both mean the
  // same thing to every reader, and collapsing them is deliberate: a page that flashed a welcome
  // screen for one frame while it waited for a snapshot would do it on every launch, not the first.
  check("no host has said anything, so nothing is shown", !firstRunOnScreen({ progress: null, dismissed: false }));
  check("a first launch shows the screens", firstRunOnScreen({ progress: running, dismissed: false }));
  // DECIDED ONCE, FROM THE MARKER, and never from live state. The steps run on EVERY launch — an
  // upgrade re-extracts, `uv sync` re-syncs — and a page that rendered them because one was briefly
  // in flight would greet a returning user with a setup flow for a machine set up months ago.
  check(
    "a later launch runs the same steps and shows none of it",
    !firstRunOnScreen({ progress: parseFirstRun(payload({ required: false }))!, dismissed: false }),
  );
  check("pressing past the ready screen ends it", !firstRunOnScreen({ progress: done, dismissed: true }));
  check(
    "...and a finished first run that has NOT been pressed past is still on screen",
    firstRunOnScreen({ progress: parseFirstRun(payload({ complete: true }))!, dismissed: false }),
  );
}
{
  // The regression this store's `apply` is written against: a step failing months later, on an
  // already-initialised machine, must not throw a setup screen over a working application.
  const laterFailure: FirstRunProgress = parseFirstRun(
    payload({
      required: false,
      steps: [
        { id: "storage", label: "App storage", state: "done", detail: null },
        { id: "python", label: "Python runtime", state: "done", detail: null },
        { id: "dependencies", label: "Runtime dependencies", state: "failed", detail: null },
        { id: "checkpoints", label: "Checkpoint database", state: "pending", detail: null },
      ],
      message: "could not re-sync after an upgrade",
    }),
  )!;
  check(
    "a step failing on an already-set-up machine never takes the screen",
    !firstRunOnScreen({ progress: laterFailure, dismissed: false }),
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

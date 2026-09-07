// Which of the two windows the page asks the shell for, and the three ways that goes wrong.
//
// EVERY ASSERTION HERE IS ABOUT A CALL THAT SHOULD OR SHOULD NOT HAPPEN, because that is the whole
// of this module's behaviour: it holds no state a screen renders and returns nothing anybody reads.
// The failures it can have are a call too many, a call too few, and a call in a browser.
//
// THE ONE WORTH THE SUITE IS THE MEMO. Sending the same stage twice is not a wasted message — the
// shell re-centres the window on every stage, so a second `app` would yank a window somebody had
// just dragged back to where they wanted it. React will re-run the effect that calls this on any
// re-render whose dependencies moved, and under StrictMode it runs every effect twice on purpose,
// so "only when it changes" is load-bearing rather than an optimisation. And its opposite is the
// bug hiding behind it: a call that FAILED must not be remembered as sent, or a shell that missed
// one stage would never be told again and the window would stay the wrong size for the session.
//
//   npm run test:window-stage

import { hasHostWindow, resetWindowStageForTests, setWindowStage } from "./windowStage.ts";
import { splashOnScreen } from "../store/splashStore.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Sent {
  command: string;
  args: unknown;
}

const global = globalThis as { __TAURI__?: unknown };

/**
 * Run with a host bridge in place, collecting what it was asked for.
 *
 * `settle` decides what `invoke` returns, so the rejection path — the one the memo has to forget —
 * is exercised rather than reasoned about.
 */
async function withHost(
  settle: "resolve" | "reject",
  run: (sent: Sent[]) => void | Promise<void>,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const previous = global.__TAURI__;
  global.__TAURI__ = {
    core: {
      invoke(command: string, args?: unknown) {
        sent.push({ command, args });
        return settle === "resolve" ? Promise.resolve(null) : Promise.reject(new Error("no"));
      },
    },
  };
  resetWindowStageForTests();
  try {
    await run(sent);
    // The memo is cleared inside a rejected promise's `catch`, which is a microtask later than the
    // call that scheduled it. Without this the "it retries" assertion below would read the memo
    // before the failure had been recorded and pass for the wrong reason.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    if (previous === undefined) delete global.__TAURI__;
    else global.__TAURI__ = previous;
    resetWindowStageForTests();
  }
  return sent;
}

console.log("\nwithout a host there is no native window to size");
{
  const previous = global.__TAURI__;
  delete global.__TAURI__;
  resetWindowStageForTests();
  check("a browser has no host window", hasHostWindow() === false);
  // It must not throw, which is the only observable behaviour available: `npm run dev` in a tab
  // renders every one of these screens and none of them has a frame to resize.
  let threw = false;
  try {
    setWindowStage("splash");
    setWindowStage("app");
  } catch {
    threw = true;
  }
  check("asking for a stage anyway is a no-op rather than a throw", !threw);
  if (previous !== undefined) global.__TAURI__ = previous;
  resetWindowStageForTests();
}

console.log("\nunder a host, the stage reaches the shell");
{
  const sent = await withHost("resolve", () => {
    check("a host window is detected", hasHostWindow() === true);
    setWindowStage("splash");
  });
  check("one call", sent.length === 1, `${sent.length}`);
  check("...to the shell's own command", sent[0]?.command === "set_window_stage");
  check("...carrying the stage", JSON.stringify(sent[0]?.args) === JSON.stringify({ stage: "splash" }));
}

console.log("\nthe same stage twice is one call, because the second would re-centre the window");
{
  const sent = await withHost("resolve", () => {
    setWindowStage("app");
    setWindowStage("app");
    setWindowStage("app");
  });
  check("three asks, one call", sent.length === 1, `${sent.length}`);
}

console.log("\n...and a change is always sent");
{
  const sent = await withHost("resolve", () => {
    setWindowStage("splash");
    setWindowStage("app");
    setWindowStage("splash");
  });
  check("three distinct stages, three calls", sent.length === 3, `${sent.length}`);
  check(
    "in the order they were asked for",
    sent.map((s) => (s.args as { stage: string }).stage).join(",") === "splash,app,splash",
  );
}

console.log("\na stage the shell refused is not remembered as delivered");
{
  // THE BUG THIS IS FOR: remember a failed call and the window keeps whatever size it had, for the
  // rest of the session, with nothing on screen to say why. The retry is free — the next render
  // asks again — but only if the memo let go.
  const sent = await withHost("reject", async (calls) => {
    setWindowStage("splash");
    await Promise.resolve();
    await Promise.resolve();
    setWindowStage("splash");
    check("the refused stage is asked for again", calls.length === 2, `${calls.length}`);
  });
  check("both attempts reached the bridge", sent.length === 2, `${sent.length}`);
}

console.log("\nand the rule that decides which stage it is");
{
  // Two booleans and no third, which is why this is a function rather than a condition written out
  // at each of its two call sites — the gate that renders the screen and the effect that sizes the
  // window for it. Those two disagreeing is a welcome screen in an application-sized window.
  check("pending, under a host — the welcome screen", splashOnScreen(true, true) === true);
  check("already dismissed this launch", splashOnScreen(false, true) === false);
  check("pending, but in a browser", splashOnScreen(true, false) === false);
  check("neither", splashOnScreen(false, false) === false);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

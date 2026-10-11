// THE GUARD THAT DECIDES WHETHER A BARE LETTER SPENDS MONEY.
//
// `R` re-runs the last test input. Its listener is on `window`, registered from `BuildPane`, and
// that pane stays mounted behind a full-screen destination on purpose. It guarded the modifiers and
// the typing targets and not the destination — so `r` pressed on the Threads board dispatched a
// real run of whichever agent the sidebar had selected, completed it, wrote a `runs` row, and
// changed nothing on a screen that has no run button, no composer and no trace panel to change.
//
// EVERY ASSERTION IN THE FIRST BLOCK IS THAT REFUSAL. They look like four ways of writing one
// check, and they are the four screens the audit dispatched a run from.
//
// AND THE SECOND BLOCK IS WHY THE RULE NEEDED TWO FUNCTIONS RATHER THAN ONE. The obvious fix —
// "never while a destination is up" — applied everywhere would disable `j`, `k`, `/` and `n` on the
// Threads board, which are mounted BY that board and are the only keys it has. A single predicate
// would have traded a silent run for four dead keys, so the distinction is named: a handler
// belonging to the three-pane view stands down, a handler belonging to the destination does not.
//
//   npm run test:bare-keys

import { insideKeyOwner, isTypingTarget, paneOwnsBareKey, rerunDecision, viewOwnsBareKey, type BareKeyEvent } from "./bareKeys.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A bare `r` on the document body — the event the R listener exists for. */
const bare = (over: Partial<BareKeyEvent> = {}): BareKeyEvent => ({
  metaKey: false, ctrlKey: false, altKey: false,
  target: { tagName: "BODY", isContentEditable: false } as unknown as EventTarget,
  ...over,
});

const el = (tagName: string, isContentEditable = false): EventTarget =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

const THREE_PANE = { navView: null, paletteOpen: false };

console.log("\nthe four screens a bare `r` started a run from");
{
  for (const view of ["agents", "work", "inbox", "activity"]) {
    check(`the ${view} destination owns the screen, so the pane's bare keys stand down`,
      paneOwnsBareKey(bare(), { navView: view, paletteOpen: false }) === false);
  }
  check("and in the ordinary three-pane view it still fires",
    paneOwnsBareKey(bare(), THREE_PANE) === true);
}

console.log("\nthe two halves that were already guarded, kept");
{
  check("a modifier is somebody else's chord", paneOwnsBareKey(bare({ metaKey: true }), THREE_PANE) === false);
  check("...ctrl too", paneOwnsBareKey(bare({ ctrlKey: true }), THREE_PANE) === false);
  check("...alt too", paneOwnsBareKey(bare({ altKey: true }), THREE_PANE) === false);
  check("typing in a field is typing", paneOwnsBareKey(bare({ target: el("INPUT") }), THREE_PANE) === false);
  check("...a textarea is the composer", paneOwnsBareKey(bare({ target: el("TEXTAREA") }), THREE_PANE) === false);
  check("...a select swallows letters", paneOwnsBareKey(bare({ target: el("SELECT") }), THREE_PANE) === false);
  check("...and so does a rename in progress",
    paneOwnsBareKey(bare({ target: el("DIV", true) }), THREE_PANE) === false);
  check("the palette is an overlay and takes the keys",
    paneOwnsBareKey(bare(), { navView: null, paletteOpen: true }) === false);
}

console.log("\na destination's OWN bare keys are not disabled by the same rule");
{
  // The mirror. A destination's own key listener is mounted BY that destination, so `navView` is set for every event it
  // will ever see — a navView clause there would be the fix that broke the feature.
  check("j/k on the board still fire while the board is up", viewOwnsBareKey(bare(), { paletteOpen: false }) === true);
  check("...but not with a modifier", viewOwnsBareKey(bare({ ctrlKey: true }), { paletteOpen: false }) === false);
  check("...not while typing into the filter",
    viewOwnsBareKey(bare({ target: el("INPUT") }), { paletteOpen: false }) === false);
  check("...and not under the palette", viewOwnsBareKey(bare(), { paletteOpen: true }) === false);
}

console.log("\nwhat counts as typing");
{
  check("an input", isTypingTarget(el("INPUT")) === true);
  check("a textarea", isTypingTarget(el("TEXTAREA")) === true);
  check("a select", isTypingTarget(el("SELECT")) === true);
  check("a contenteditable div", isTypingTarget(el("DIV", true)) === true);
  check("a plain div is not", isTypingTarget(el("DIV")) === false);
  check("a button is not", isTypingTarget(el("BUTTON")) === false);
  check("nothing at all is not", isTypingTarget(null) === false);
}

console.log("\na region that owns its bare keys — the graph canvas");
{
  // A node or the canvas itself has focus after a click, and neither is a typing target. Faked with
  // the one method the predicate reads, matching or not.
  const owned = { tagName: "DIV", isContentEditable: false, closest: (s: string) => (s === "[data-owns-bare-keys]" ? {} : null) } as unknown as EventTarget;
  const plain = { tagName: "DIV", isContentEditable: false, closest: () => null } as unknown as EventTarget;
  check("a focused graph node is inside a key owner", insideKeyOwner(owned) === true);
  check("...a plain element is not", insideKeyOwner(plain) === false);
  check("...nor nothing at all", insideKeyOwner(null) === false);
  check("so the pane's `r` stands down there", paneOwnsBareKey(bare({ target: owned }), THREE_PANE) === false);
  check("...and still fires on a plain element", paneOwnsBareKey(bare({ target: plain }), THREE_PANE) === true);
}

console.log("\nwhat a bare `r` may do");
{
  const r = { key: "r", shiftKey: false, repeat: false };
  const ready = { lastInput: "abc", canRun: true, live: false, justSent: false, keyed: true };
  check("a last input, a key, nothing live: it re-runs", rerunDecision(r, ready) === "run");
  // The issue's two halves: an agent that has never run has nothing to repeat — with a key it ran
  // an empty input, without one it moved the panel to Secrets.
  check("no last input: nothing", rerunDecision(r, { ...ready, lastInput: null }) === "nothing");
  check("...an empty one: nothing", rerunDecision(r, { ...ready, lastInput: "  \n " }) === "nothing");
  check("...and nothing, not Secrets, without a key either", rerunDecision(r, { ...ready, lastInput: null, keyed: false }) === "nothing");
  check("a last input without a key says so", rerunDecision(r, { ...ready, keyed: false }) === "needs-key");
  // Eight runs in a minute, one per capital R in a line of text that reached the page.
  check("a capital R is typing", rerunDecision({ ...r, key: "R", shiftKey: true }, ready) === "nothing");
  check("a held r does not repeat a run", rerunDecision({ ...r, repeat: true }, ready) === "nothing");
  check("a run already live: nothing", rerunDecision(r, { ...ready, live: true }) === "nothing");
  check("one sent a moment ago: nothing", rerunDecision(r, { ...ready, justSent: true }) === "nothing");
  check("an agent that cannot run: nothing", rerunDecision(r, { ...ready, canRun: false }) === "nothing");
}

console.log("\nneither predicate is stuck at a constant");
{
  check("paneOwnsBareKey says both things",
    paneOwnsBareKey(bare(), THREE_PANE) === true &&
    paneOwnsBareKey(bare(), { navView: "agents", paletteOpen: false }) === false);
  check("viewOwnsBareKey says both things",
    viewOwnsBareKey(bare(), { paletteOpen: false }) === true &&
    viewOwnsBareKey(bare(), { paletteOpen: true }) === false);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

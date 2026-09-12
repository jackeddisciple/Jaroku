// §14's bindings, and the four rules that are invisible until somebody hits them.
//
// WHY A TABLE AND NOT A RENDER. Every one of §14.1's rows is a CONDITION, and the failures are all
// of the same shape: a binding that fires when it should not, in a situation nobody tests by hand.
//
//   `↑` INSIDE A DRAFT would move somebody's caret out of the third line of a paragraph they were
//   writing, and they would not know why. §14 names this one twice: "only when the composer is
//   empty, so it never eats cursor movement inside a draft", and again in its acceptance.
//
//   `R` ALREADY RUNS THE AGENT — a real run that spends money. §14 asks for it to regenerate the
//   selected turn, and the product owner's call is that the selection decides. A table that claimed
//   `R` unconditionally would have made a keystroke on a conversation start a billable run.
//
//   `Esc` MUST NOT CLOSE THE VIEW. §14.1: "with no stream open, clears the composer selection
//   state; never closes the view." An Esc that bubbled would take the pane away from somebody who
//   meant to stop an answer that had already finished.
//
//   AND J/K MUST HAVE A WAY OUT. §14.2: "typing a printable character returns focus to the composer
//   and starts a draft with that character, so the keyboard never becomes a trap." Without it, the
//   way out of navigation mode is the mouse, in a surface whose whole claim is that it does not
//   need one.
//
//   npm run test:chat-keys

import { chatKeyAction, type ChatKeyState } from "./chatKeys.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const state = (over: Partial<ChatKeyState> = {}): ChatKeyState => ({
  streaming: false,
  selectedTurnId: null,
  selectedIsRegenerable: false,
  composerEmpty: true,
  typing: false,
  viewOwnsScreen: false,
  paletteOpen: false,
  ...over,
});

const press = (key: string, s: ChatKeyState = state(), mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  chatKeyAction({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }, s);

// --- §14.1's table ----------------------------------------------------------------------------

console.log("\n§14.1 — the bindings");
{
  check("J moves to the next turn", press("j")?.do === "moveTurn" && (press("j") as { delta: number }).delta === 1);
  check("K moves to the previous", press("k")?.do === "moveTurn" && (press("k") as { delta: number }).delta === -1);
  check("...and the capitals do the same", press("J")?.do === "moveTurn" && press("K")?.do === "moveTurn");
  check("Enter expands the selected turn", press("Enter", state({ selectedTurnId: "t1" }))?.do === "expandTurn");
  // NOTHING SELECTED MEANS NOTHING TO EXPAND, and Enter is the composer's own key besides.
  check("...and does nothing with no selection", press("Enter") === null);
  check("↑ opens the last message for editing", press("ArrowUp")?.do === "editLast");
  check("Esc stops a streaming turn", press("Escape", state({ streaming: true }))?.do === "stop");
}

console.log("\n§14.1 — ↑ never eats cursor movement inside a draft");
{
  // THE ACCEPTANCE CASE, VERBATIM: "↑ with a non-empty composer moves the cursor and does not open
  // the editor."
  check("↑ in a non-empty draft is not ours",
    press("ArrowUp", state({ typing: true, composerEmpty: false })) === null);
  // AND AN EMPTY COMPOSER IS THE CASE THE BINDING IS FOR, even with the caret in it — which is
  // where the caret almost always is.
  check("↑ in an empty composer opens the editor",
    press("ArrowUp", state({ typing: true, composerEmpty: true }))?.do === "editLast");
}

console.log("\n§14.1 — Esc never closes the view");
{
  const idle = press("Escape", state({ streaming: false, selectedTurnId: "t1" }));
  check("with no stream open, Esc clears the selection", idle?.do === "clearSelection", JSON.stringify(idle));
  check("...and never returns null, which would let it bubble", idle !== null);
  // IT WORKS WHILE TYPING, which is the one key that must: somebody halfway through their next
  // message is exactly the person who wants to stop the answer to the last one.
  check("Esc works with the caret in the composer",
    press("Escape", state({ streaming: true, typing: true }))?.do === "stop");
  // THE PALETTE IS AN OVERLAY AND OWNS ITS OWN ESC.
  check("the palette keeps its Esc", press("Escape", state({ streaming: true, paletteOpen: true })) === null);
}

// --- the R collision --------------------------------------------------------------------------

console.log("\n§14.1 — R, and the binding it shares a key with");
{
  // WITH A REGENERABLE TURN SELECTED, R regenerates it — which is what §14.1's table asks for.
  check("R regenerates the selected turn",
    press("r", state({ selectedTurnId: "t1", selectedIsRegenerable: true }))?.do === "regenerate");
  // WITH NOTHING SELECTED, R IS NOT OURS — so `BuildPane`'s existing binding runs the agent exactly
  // as it did. This is the whole of the product owner's call, and the assertion that makes it true:
  // a `regenerate` here would have made a keystroke on a conversation start a billable run.
  check("R with nothing selected is left alone", press("r", state()) === null);
  // AND A SELECTED TURN THAT CANNOT BE REGENERATED IS ALSO NOT OURS — a plan, a generation, a
  // proposal, or a reply the server has not filed yet. `canRerunTurn` is the predicate; this
  // respects its answer rather than offering a control that cannot dispatch.
  check("R on a turn that cannot be regenerated is left alone",
    press("r", state({ selectedTurnId: "t1", selectedIsRegenerable: false })) === null);
}

// --- §14.2's way out of navigation mode -------------------------------------------------------

console.log("\n§14.2 — the keyboard never becomes a trap");
{
  const s = state({ selectedTurnId: "t1" });
  const typed = press("a", s);
  check("a printable character starts a draft", typed?.do === "startDraft", JSON.stringify(typed));
  check("...with that character in it", (typed as { char: string }).char === "a");
  check("a digit does too", press("7", s)?.do === "startDraft");
  check("...and so does punctuation", press("?", s)?.do === "startDraft");
  // SPACE IS DELIBERATELY NOT PRINTABLE HERE: it is how somebody scrolls a conversation they are
  // reading, and starting a draft with a leading space would take the page out from under them.
  check("space is not a draft", press(" ", s) === null);
  // NAMED KEYS ARE NOT CHARACTERS. `KeyboardEvent.key` is the character for a printable key and a
  // NAME for everything else, which is what the length test reads.
  for (const key of ["Tab", "Backspace", "F5", "ArrowLeft", "Shift", "CapsLock", "Home"]) {
    check(`${key} is not a draft`, press(key, s) === null);
  }
  // AND NOTHING SELECTED MEANS NOTHING TO ESCAPE FROM — a bare letter with no selection belongs to
  // whoever else claims it.
  check("a printable character with no selection is not ours", press("a", state()) === null);
}

// --- who owns the screen ----------------------------------------------------------------------

console.log("\nthe surface stands down when something else owns the screen");
{
  // `bareKeys.ts`'s RULE, AND ITS REASON: pressing `r` on the Threads board once dispatched a real
  // run of whichever agent was selected in the sidebar, because that listener guarded the modifiers
  // and the typing target and missed the one about the rest of the application.
  const behind = state({ selectedTurnId: "t1", selectedIsRegenerable: true, viewOwnsScreen: true });
  for (const key of ["j", "k", "r", "Enter", "ArrowUp", "a"]) {
    check(`${key} is not ours behind a full-screen view`, press(key, behind) === null);
  }
  const overlay = state({ selectedTurnId: "t1", selectedIsRegenerable: true, paletteOpen: true });
  for (const key of ["j", "k", "r", "Enter", "ArrowUp", "a"]) {
    check(`${key} is not ours with the palette open`, press(key, overlay) === null);
  }
}

console.log("\na modifier means it is not ours");
{
  // `⌘↵` IS THE COMPOSER'S SEND AND `⌘K` IS THE PALETTE. A table that claimed bare letters without
  // checking would have eaten both.
  const s = state({ selectedTurnId: "t1", selectedIsRegenerable: true });
  for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
    for (const key of ["j", "k", "r", "Enter", "ArrowUp"]) {
      check(`${mod}+${key} is not ours`, press(key, s, { [mod]: true }) === null);
    }
  }
  // SHIFT IS NOT A MODIFIER FOR THIS PURPOSE: `Shift+j` produces `J`, which is the same binding.
  check("Shift+J still moves", press("J", s, { shiftKey: true })?.do === "moveTurn");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

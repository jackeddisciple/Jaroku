// When a trigger fires, and — the half that matters — when it must not.
//
// A picker that opens while somebody is typing an email address is worse than no shortcut at all:
// it is a popover they have to dismiss to keep writing a sentence, on every message that happens
// to contain an `@`. So most of this file is negative cases, and they are all one rule — a trigger
// only counts at the start of a word.
//
// THE OTHER PROPERTY UNDER TEST is availability. §A.6 says `@` and `!` are ABSENT before Phase 2,
// not shown-and-disabled, matching how §7 hides its Phase-2 menu entries rather than greying them
// out. A trigger that is not available has to be an ordinary character, not a dead one.
//
//   npm run test:composer-triggers

import { activeTrigger, removeTrigger, type TriggerKind } from "./composerTriggers.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const ALL: TriggerKind[] = ["commit", "file", "sync"];
/** Caret at the end, which is where it is while somebody is typing. */
const at = (text: string, available: readonly TriggerKind[] = ALL) =>
  activeTrigger(text, text.length, available);

console.log("\nthe triggers fire");
{
  const commit = at("Why did someone remove the retry logic — check #a1b2");
  check(commit?.kind === "commit" && commit.query === "a1b2", "# opens the commit picker, filtered by what follows");
  const file = at("Compare this against @tools/we");
  check(file?.kind === "file" && file.query === "tools/we", "@ opens the file picker, filtered by path");
  check(at("!")?.kind === "sync", "! is a single-token insert");
  check(at("#")?.query === "", "a bare trigger is active with an empty query");
  // People write parentheses. A rule that only accepted whitespace would refuse the thing it was
  // written to allow while still accepting the email address.
  check(at("(see #a1b2")?.kind === "commit", "an opening bracket is a word boundary too");
}

console.log("\nand — the half that matters — they do not");
{
  // Every one of these is a real string somebody types into a chat box.
  check(at("ada@example.com") === null, "an email address is not a file picker");
  check(at("#ff0000") !== null, "a bare colour DOES open the picker — it is at a word start");
  check(at("issue#42") === null, "...but a hash inside a word does not");
  check(at("--flag=@ref") === null, "nor one after an equals sign");
  check(at("run the tests!") === null, "an exclamation ending a sentence is punctuation");
  check(at("!later") === null, "and ! takes no filter, so anything after it is just a word");
  check(at("check #a1b2 and then") === null, "a trigger the caret has typed past is closed");
  check(activeTrigger("check #a1b2 now", 11, ALL)?.query === "a1b2", "...while the caret inside it is still open");
}

console.log("\navailability is absence, not a disabled state");
{
  // §A.6: before Phase 2, @ and ! are simply not triggers. Typing one types a character.
  const phase1: TriggerKind[] = ["commit"];
  check(at("#a1b2", phase1)?.kind === "commit", "# is live in Phase 1 — it needs only push history");
  check(at("@tools/x", phase1) === null, "@ is not a trigger before there is sync state behind it");
  check(at("!", phase1) === null, "nor is !");
}

console.log("\nremoving the token");
{
  const text = "check #a1b2 now";
  const trigger = activeTrigger(text, 11, ALL)!;
  const out = removeTrigger(text, trigger);
  // The attachment becomes a chip above the composer. Leaving the token in the prose would send
  // the model the same reference twice — once as text it cannot resolve, once as context it can.
  check(out.text === "check now", "the token is removed rather than replaced with a label", out.text);
  check(out.caret === 6, "and the caret lands where the token was", String(out.caret));

  const trailing = "check #a1b2";
  const t2 = activeTrigger(trailing, trailing.length, ALL)!;
  check(removeTrigger(trailing, t2).text === "check ", "a trigger at the end leaves the space the user typed");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// Reached through globalThis: the client has no @types/node on purpose, so a component touching
// `process` fails to compile rather than fails to run.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

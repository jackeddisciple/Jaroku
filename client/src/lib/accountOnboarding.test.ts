// §5's step arithmetic, and the two rules that are easy to get subtly wrong.
//
// THE FLOW IS FIVE SCREENS AND ONE INTEGER, which is what makes §5.3's resume possible: the server
// stores a number, a screen is `STEPS[n - 1]`, and "advance" is `n + 1`. Everything in this file is
// therefore pure, which is the only reason these rules get exercised at all — a resume that could
// only be checked by closing a desktop app mid-flow and reopening it is a rule nobody checks.
//
// THE TWO THAT MATTER MOST:
//
//   THE ENGAGEMENT THRESHOLD. §5.2 sets it at step 3, and both directions of getting it wrong are
//   real. Too low and closing the window on the welcome screen marks somebody onboarded — they
//   never see the flow again and never name a workspace. Too high and somebody who set everything
//   up and closed the app on the last screen is walked through it all again.
//
//   THE FIRST NAME. It is used in a greeting and in a pre-filled workspace name, and the failure
//   mode is not a crash — it is "Welcome, ada.lovelace+jaroku", on the first screen somebody sees
//   after signing up. Which is why the null path is asserted as hard as the happy one.
//
//   npm run test:account-onboarding

import {
  ENGAGEMENT_STEP,
  FIRST_STEP,
  LAST_STEP,
  ONBOARDING_STEPS,
  countsAsEngaged,
  defaultWorkspaceName,
  firstNameOf,
  nextStep,
  previousStep,
  stepAt,
} from "./accountOnboarding.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

console.log("\nthe five screens, and the number that names one");
{
  // Renumbering these — dropping the welcome screen because it has no input on it, say — would make
  // §5.3's "1-5" and §5.2's "at least Step 3" say something different about a column people already
  // have values in.
  check("there are five", ONBOARDING_STEPS.length === 5);
  check("...in §5.1's order", ONBOARDING_STEPS.join(",") === "welcome,workspace,provider,agent,ready");
  check("the first is 1 and the last is 5", FIRST_STEP === 1 && LAST_STEP === 5);

  check("step 1 is the welcome screen", stepAt(1) === "welcome");
  check("step 2 is the workspace name, which is the only mandatory one", stepAt(2) === "workspace");
  check("step 3 is the provider key", stepAt(3) === "provider");
  check("step 4 is the first agent", stepAt(4) === "agent");
  check("step 5 is the summary", stepAt(5) === "ready");
}
{
  // CLAMPED RATHER THAN REFUSED, because the input is a database column and a column can hold a
  // number no screen renders — a row written by a newer build, a value set by hand, a migration
  // that defaulted differently. Somebody meeting a blank onboarding they cannot leave is a far
  // worse outcome than one meeting the first screen twice.
  check("a step below the first clamps to it", stepAt(0) === "welcome");
  check("...and a negative one", stepAt(-4) === "welcome");
  check("a step past the last clamps to it", stepAt(9) === "ready");
  check("a fractional step is floored rather than rounded", stepAt(2.9) === "workspace");
}

console.log("\nmoving between them");
{
  check("advancing goes forward one", nextStep(1) === 2 && nextStep(3) === 4);
  // NEVER PAST THE END. The last screen's button completes the flow rather than advancing, so a
  // step 6 would be a screen nothing renders reached by the only control on the last one.
  check("advancing from the last step stays there", nextStep(LAST_STEP) === LAST_STEP);
  check("...and so does advancing from past it", nextStep(99) === LAST_STEP);

  check("going back goes back one", previousStep(4) === 3);
  check("going back from the first stays there", previousStep(FIRST_STEP) === FIRST_STEP);
  check("...and from below it", previousStep(-2) === FIRST_STEP);
}

console.log("\nwhat counts as having onboarded");
{
  // §5.2: "either clicked 'Open Jaroku' on Step 5, OR closed the onboarding modal via any means
  // after reaching at least Step 3. Auth alone does not count."
  check("the threshold is step 3, as §5.2 sets it", ENGAGEMENT_STEP === 3);

  // TOO LOW WOULD BE THE EXPENSIVE MISTAKE: closing the window on the welcome screen would mark
  // somebody onboarded, and they would never see the flow again or name a workspace.
  check("closing on the welcome screen is NOT engagement", !countsAsEngaged(1));
  check("...and neither is closing on the workspace screen", !countsAsEngaged(2));

  check("reaching the provider step is", countsAsEngaged(3));
  check("...and everything past it", countsAsEngaged(4) && countsAsEngaged(5));
  // The other direction: somebody who set everything up and closed the app on the last screen must
  // not be walked through it all again.
  check("...including the last screen", countsAsEngaged(LAST_STEP));
}

console.log("\nthe first name, which goes on the first screen somebody sees");
{
  check("an ordinary name splits", firstNameOf("Ada Lovelace") === "Ada");
  check("a mononym is the whole thing", firstNameOf("Prince") === "Prince");
  check("extra whitespace does not produce an empty token", firstNameOf("   Grace   Hopper ") === "Grace");
  // EVERY HEURISTIC BEYOND "THE FIRST TOKEN" IS WRONG FOR A LARGE SHARE OF THE WORLD. What this
  // produces for these three is, respectively: right, acceptable, and right.
  check("a Han name is not split backwards", firstNameOf("李伟") === "李伟");
  check("a three-word given name yields its first word", firstNameOf("Maria del Carmen") === "Maria");
  check("a name with an emoji in it survives", firstNameOf("Ada 🌸") === "Ada");
}
{
  // NEVER AN EMAIL ADDRESS. "Welcome, ada.lovelace+jaroku" is worse than no greeting, and the null
  // is what lets the screen say "Welcome to Jaroku" on its own instead.
  check("no name yields null rather than a guess", firstNameOf(null) === null);
  check("an empty name yields null", firstNameOf("") === null);
  check("...and one that is only whitespace", firstNameOf("   ") === null);
}

console.log("\nthe pre-filled workspace name");
{
  // §5.1: "Pre-filled with {firstName}'s workspace."
  check("it is built from the first name", defaultWorkspaceName("Ada Lovelace") === "Ada's workspace");
  check("...for a mononym too", defaultWorkspaceName("Prince") === "Prince's workspace");
  // A mandatory field that starts empty is a mandatory field somebody has to think about, and this
  // one has a perfectly good default they can accept without reading.
  check("with no name it is still a real default, not an empty box", defaultWorkspaceName(null) === "My workspace");
  check("...and not something with 'null' in it", !defaultWorkspaceName(null).includes("null"));
  // §5.1: "1-60 chars". Every default this can produce has to fit inside what the server accepts,
  // or accepting the default would be refused.
  check("even a very long name produces something inside the limit", defaultWorkspaceName("Wolfeschlegelsteinhausenbergerdorff").length <= 60);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

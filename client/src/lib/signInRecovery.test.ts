// A SIGN-IN ATTEMPT THAT NEVER COMES BACK LEAVES THE SCREEN USABLE.
//
// `SignInScreen` starts a Google flow, sets `busy`, and waits for a deep link. When the deep link
// does not arrive — a `jaroku://` scheme registered by another application, a webview outside a
// bundle, a browser that refuses to hand a custom scheme to a background app, or Google refusing
// the redirect URI outright — a ninety-second timer sets `stalled`, the button's label goes back
// to "Continue with Google", and a paragraph appears telling the reader to press it.
//
// PRESSING IT DID NOTHING. `google()` opened with `if (busy) return`, and the timeout never
// cleared `busy` — it only set a second flag that the LABEL read. So the control was re-enabled on
// `!stalled`, described in the copy beside it as the way out, and guarded on a variable that said
// an attempt was still running. The email field was worse: its `disabled={busy !== null}` had no
// notion of stalling at all, so a Google attempt that never returned disabled the OTHER sign-in
// path for the life of the process. Both were reached through the recovery timeout itself, which
// is what makes this worth a suite: the screen looked more recovered after ninety seconds than it
// was, and every part of that was invisible to the typechecker.
//
// THE INVARIANT, AND WHY IT IS SPELT AS ONE NAME. `busy` answers "which flow was started" — the
// label and the help paragraph need it, so it must survive the timeout. "Is an attempt still
// running" is a different question, it is the one every guard means, and the two answers diverge
// exactly once: after the stall. `inFlight` is that second question written down once, and this
// suite's rule is that nothing gates on the first one.
//
// A SOURCE SCAN, for `deadControls.test.ts`'s reason and with its limits. This client has no DOM
// test harness, and the failure is a `disabled` prop disagreeing with a guard twenty lines away —
// which is a property of the text. It cannot see a NEW guard invented under a third name; what it
// can see is the shape that actually shipped.
//
//   npm run test:sign-in-recovery

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Comments blanked, line count preserved — this file argues with itself at length too. */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/.*$/gm, blanked);
}

const SCREEN = strip(readFileSync(`${HERE}../components/auth/SignInScreen.tsx`, "utf8"));

console.log("\nthe screen knows the difference between busy and still running");
{
  check(
    "`inFlight` is defined, and as both facts together",
    /const\s+inFlight\s*=\s*busy\s*!==\s*null\s*&&\s*!stalled\s*;/.test(SCREEN),
    "expected `const inFlight = busy !== null && !stalled;`",
  );

  // `busy` still has to exist and still has to survive the stall: the help paragraph is rendered
  // on `busy === "google" && stalled`, so a fix that simply cleared `busy` on the timeout would
  // take the recovery instructions off the screen with it.
  check(
    "the stall keeps `busy`, so the guidance about it still renders",
    /busy\s*===\s*"google"\s*&&\s*stalled/.test(SCREEN),
  );
  check(
    "the timeout sets `stalled` rather than clearing `busy`",
    /setTimeout\(\s*\(\)\s*=>\s*setStalled\(true\)/.test(SCREEN),
  );
}

console.log("\nnothing that gates an action reads `busy` directly");
{
  // Every early return in an action handler.
  const guards = [...SCREEN.matchAll(/if\s*\(\s*(busy|inFlight)\s*\)\s*return\s*;/g)].map((m) => m[1] ?? "");
  check("found the handlers' early returns", guards.length >= 3, `found ${guards.length}`);
  const onBusy = guards.filter((g) => g === "busy");
  check(
    "every early return guards on `inFlight`",
    onBusy.length === 0,
    `${onBusy.length} still return early on \`busy\``,
  );

  // Every `disabled` prop on this screen.
  const disabled = [...SCREEN.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => (m[1] ?? "").trim());
  check("found the disabled props", disabled.length >= 5, `found ${disabled.length}`);
  const readingBusy = disabled.filter((d) => /\bbusy\b/.test(d));
  check(
    "no disabled prop is computed from `busy`",
    readingBusy.length === 0,
    readingBusy.join(" | "),
  );
  check(
    "and they are computed from `inFlight` instead",
    disabled.filter((d) => /\binFlight\b/.test(d)).length >= 5,
    disabled.join(" | "),
  );
}

console.log("\nstarting a new attempt clears the old one's stall");
{
  // Otherwise `inFlight` stays false THROUGH the new request — the field and the button would both
  // remain live while a link was being sent, which is the double-submit the guards exist to refuse.
  // `google()` already did this; the two form handlers did not, because before `inFlight` nothing
  // depended on it.
  for (const [name, fn] of [
    ["google", /const google = async \(\): Promise<void> => \{[\s\S]*?\n  \};/],
    ["submitEmail", /const submitEmail = async \(e: React\.FormEvent\): Promise<void> => \{[\s\S]*?\n  \};/],
    ["devSubmit", /const devSubmit = async \(e: React\.FormEvent\): Promise<void> => \{[\s\S]*?\n  \};/],
  ] as const) {
    const body = fn.exec(SCREEN)?.[0] ?? "";
    check(`${name} was found`, body.length > 0);
    if (body) check(`${name} resets \`stalled\` when it starts`, /setStalled\(false\)/.test(body));
  }
}

console.log("\nthe recovery the copy promises is the recovery that exists");
{
  // The paragraph tells the reader to press Continue with Google. The button must therefore be
  // enabled in exactly the state that paragraph is shown.
  check(
    "the help text names the control it expects to work",
    /press Continue with Google to start again/.test(SCREEN),
  );
  // Up to the line that is just `>`: a non-greedy stop at the first `>` lands inside
  // `onClick={() => …}`, which is a JSX arrow and not the end of the tag.
  const googleBtn = /<SecondaryButton\b[\s\S]*?\n\s*>/.exec(SCREEN)?.[0] ?? "";
  check("the Google button was found", googleBtn.length > 0);
  check(
    "and it is disabled only while something is genuinely in flight",
    /disabled=\{inFlight\}/.test(googleBtn),
    googleBtn.replace(/\s+/g, " ").slice(0, 160),
  );
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// Through `globalThis`: the client has no @types/node on purpose.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

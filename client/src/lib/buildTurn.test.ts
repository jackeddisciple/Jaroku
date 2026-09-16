// What answering a build turn on the user's own subscription must get right.
//
//   npm run test:build-turn

import { BUILD_TIMEOUT_MS, FLUSH_MS, runBuildTurn } from "./buildTurn.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

/**
 * THE APP MUST GIVE UP BEFORE THE SERVER DOES, and this is the assertion that keeps it true.
 *
 * `SubscriptionTurns` holds a build for twenty minutes and then abandons it. If this app waited
 * longer, the server would give up first and the person would be told the app never answered — while
 * the CLI was still running and about to. Whoever changes either number has to change both, and this
 * is what makes forgetting a build failure rather than a confusing report weeks later.
 */
check(
  "the app's own deadline is inside the server's twenty-minute hold",
  BUILD_TIMEOUT_MS < 20 * 60_000,
);

// Long enough for a generation, which is the long one: 2m22s and 16,689 output tokens, measured
// 2026-09-16. A deadline under that would abandon a build that was working.
check("...and still leaves room for a real generation", BUILD_TIMEOUT_MS >= 5 * 60_000);

// Batched, not per token — see the module header. Small enough that the pane still feels live.
check("text is flushed back often enough to keep the pane alive", FLUSH_MS > 0 && FLUSH_MS <= 1000);

/**
 * A BROWSER SAYS SO RATHER THAN HANGING.
 *
 * The server is holding the turn in an `await`; a tab with no shell has no CLI and no sign-in to
 * answer with, and dropping it silently would leave the build pane spinning until the server's own
 * timeout. So the refusal is an OUTCOME — reportable — rather than a throw.
 */
const outcome = await runBuildTurn({
  provider: "anthropic",
  model: null,
  effort: null,
  system: "s",
  prompt: "p",
  onChunk: () => { throw new Error("nothing should stream without a host"); },
});
check("without a desktop host the turn fails rather than hanging", outcome.status === "error");
check("...and says what is missing", /desktop app/i.test(outcome.error ?? ""));
check("...and carries no text or token counts", outcome.raw === "" && outcome.inputTokens === null);

console.log(failures === 0 ? "\nall build-turn checks passed" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

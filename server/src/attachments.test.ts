// The attachment budget, which is §12.15: "Exceeding the context window blocks send and names the
// offending attachments — never truncates silently."
//
// THE FAILURE THIS EXISTS FOR HAS NO SYMPTOM. An over-budget request does not error. The provider
// takes what fits, drops the rest, and answers confidently about half a file — §4.4's own words:
// "Silent truncation is the worst possible behavior here — it produces a confident answer grounded
// in half a file." There is no log line, no red state, and no reason for anybody to look.
//
// So the assertions here are mostly about arithmetic leaning the right way. An estimate that came
// in LOW would let exactly that request through, which is why the estimator is deliberately
// pessimistic and why that pessimism is checked rather than assumed.
//
//   npm run test:attachments

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ATTACHMENT_KINDS, MAX_ATTACHMENTS, WARN_AT, checkBudget, checkCount, estimateTokens,
  isAttachmentKind, labelFor, validateRef, type ResolvedAttachment,
} from "./attachments.ts";
import { contextWindowFor } from "./pricing.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const att = (label: string, tokens: number): ResolvedAttachment =>
  ({ kind: "file", ref: { path: label, version_id: "v1" }, tokenEstimate: tokens, label });

console.log("\nthe five kinds are the five kinds");
{
  check("five sources, matching §4.2", ATTACHMENT_KINDS.length === 5);
  check("...and they are the spec's", ATTACHMENT_KINDS.join(",") === "file,run,dataset_case,tool_schema,github");
  check("a sixth is not one", !isAttachmentKind("upload") && !isAttachmentKind(""));
  // §13 puts local uploads explicitly out of scope: "Attaching arbitrary uploads from the local
  // filesystem (project files only, for now)."
  check("and neither is a local upload", !isAttachmentKind("local_file"));
}

console.log("\nthe estimate leans HIGH, which is the only direction that is safe to block on");
{
  check("nothing costs nothing", estimateTokens("") === 0 && estimateTokens(null) === 0 && estimateTokens(undefined) === 0);
  check("it never goes negative", estimateTokens("a") > 0);

  // THE LOAD-BEARING PROPERTY. Source code tokenises nearer 3 characters per token than 4, so a
  // naive length/4 UNDER-counts — and an under-count is a send that goes through and then gets
  // truncated. The estimator has to come out above that naive figure.
  const code = "def handler(state: dict) -> dict:\n    return {**state, 'ok': True}\n".repeat(50);
  const naive = Math.ceil(code.length / 4);
  check("it exceeds a bare length/4 for source", estimateTokens(code) > naive, `${estimateTokens(code)} vs ${naive}`);
  // ...and by enough to cover the gap between 4 and roughly 3.3 characters per token.
  check("...by a margin that covers code's real density",
    estimateTokens(code) >= Math.ceil(code.length / 3.4), `${estimateTokens(code)} vs ${Math.ceil(code.length / 3.4)}`);

  // Monotonic: more text is never fewer tokens. Obvious, and the kind of thing a "clever" rounding
  // change breaks.
  check("more text is never fewer tokens", estimateTokens("ab".repeat(1000)) > estimateTokens("ab".repeat(10)));
}

console.log("\n§12.15 — over the window BLOCKS, and names what to remove");
{
  const window = contextWindowFor("claude-sonnet-5");
  check("the model has a recorded window", (window ?? 0) > 0, String(window));
  const w = window!;

  const verdict = checkBudget([att("huge.py", w), att("small.py", 10)], "claude-sonnet-5");
  check("it is over", verdict.level === "over", verdict.level);
  check("...and says so in words", (verdict.message ?? "").length > 0);
  // NAMED, not counted. "3 attachments are too large" leaves the user to work out which.
  check("...naming the attachment responsible", verdict.offending.includes("huge.py"), verdict.offending.join(","));
  check("...and the message names it too", (verdict.message ?? "").includes("huge.py"), verdict.message ?? "");

  // Largest first, and only as many as are needed to get back under the line. Listing all ten
  // would be a paragraph nobody reads, and listing the smallest first would suggest a remedy that
  // does not work.
  check("the biggest is named first", verdict.offending[0] === "huge.py");
  check("...and a small one that would not fix it is not named", !verdict.offending.includes("small.py"));
}

console.log("\n...and 70% warns without blocking, because a warning is not a refusal");
{
  const w = contextWindowFor("claude-sonnet-5")!;
  const under = checkBudget([att("a.py", Math.floor(w * 0.5))], "claude-sonnet-5");
  check("half a window is fine and silent", under.level === "ok" && under.message === null);

  const warned = checkBudget([att("a.py", Math.floor(w * (WARN_AT + 0.05)))], "claude-sonnet-5");
  check("past the warn line it warns", warned.level === "warn", warned.level);
  check("...and does NOT name anything, because nothing has to go", warned.offending.length === 0);
  check("...but still says something", (warned.message ?? "").length > 0);

  // The boundary itself. An off-by-one here is a warning that appears at 71% or never.
  const exactly = checkBudget([att("a.py", Math.ceil(w * WARN_AT))], "claude-sonnet-5");
  check("exactly at the warn line warns", exactly.level === "warn", exactly.level);
  const justUnder = checkBudget([att("a.py", Math.floor(w * WARN_AT) - 1)], "claude-sonnet-5");
  check("just under it does not", justUnder.level === "ok", justUnder.level);
}

console.log("\nthe message itself counts against the window, not just the attachments");
{
  const w = contextWindowFor("claude-sonnet-5")!;
  // An attachment that fits on its own and does not fit beside the conversation is exactly the
  // case a per-attachment check would miss.
  const alone = checkBudget([att("a.py", Math.floor(w * 0.9))], "claude-sonnet-5");
  check("it fits alone", alone.level === "warn", alone.level);
  const together = checkBudget([att("a.py", Math.floor(w * 0.9))], "claude-sonnet-5", Math.floor(w * 0.2));
  check("...and not once the conversation is counted", together.level === "over", together.level);
}

console.log("\nan unrecorded window warns rather than blocking");
{
  // The one place this feature fails toward permissive, and deliberately: refusing every send on a
  // model nobody has measured would break a model that probably works, while blocking on a number
  // we do not have would be asserting a limit we cannot name.
  const v = checkBudget([att("a.py", 999_999)], "a-model-nobody-recorded");
  check("it does not block", v.level === "ok", v.level);
  check("...and says the check could not be made", (v.message ?? "").includes("no context-window record"), v.message ?? "");
  check("...rather than claiming a window", v.window === null && v.fraction === null);

  // With nothing attached there is nothing to say at all — a notice about an unknown window on an
  // empty composer would be chrome.
  check("nothing attached, nothing said", checkBudget([], "a-model-nobody-recorded").message === null);
}

console.log("\n§4.4 — ten attachments, and a clear message on the eleventh");
{
  check("ten is the cap", MAX_ATTACHMENTS === 10);
  check("nine is fine", checkCount(9).allowed);
  check("...and so is the tenth being added", checkCount(9).message === null);
  check("the eleventh is refused", !checkCount(10).allowed);
  check("...with a sentence, not a code", (checkCount(10).message ?? "").includes("Remove one"), checkCount(10).message ?? "");
}

console.log("\na ref that cannot be reproduced later is refused now");
{
  // §4.4's reproducibility claim rests entirely on the resolved ref being stored. A file ref
  // without a version_id is a BOOKMARK — it says "whatever this path says when you read it" — and
  // storing one would make the turn describe a conversation that never happened.
  check("a file needs its version", validateRef("file", { path: "a.py" }) !== null);
  check("...and with one it is fine", validateRef("file", { path: "a.py", version_id: "v1" }) === null);
  check("a run needs a run_id", validateRef("run", {}) !== null);
  check("a dataset case needs a case_id", validateRef("dataset_case", {}) !== null);
  check("a tool schema needs a tool_id", validateRef("tool_schema", {}) !== null);
  check("a GitHub ref needs one of three things", validateRef("github", {}) !== null);
  check("...a commit is one", validateRef("github", { commit_sha: "a1b2c3d" }) === null);
  check("...a PR is another", validateRef("github", { pr: 12 }) === null);
  check("...and a path is the third", validateRef("github", { path: "a.py", ref: "main" }) === null);
  // Not an object at all — the shape a hand-written request is most likely to get wrong.
  check("a string ref is refused", validateRef("file", "tools/weather.py") !== null);
  check("an array ref is refused", validateRef("file", ["a"]) !== null);
  check("a null ref is refused", validateRef("file", null) !== null);
}

console.log("\nthe label a chip shows is the label the refusal names");
{
  // Two spellings of the same attachment — one in a chip, one in the sentence explaining why the
  // send was refused — would read as two different things.
  check("a file is its path", labelFor("file", { path: "tools/weather.py" }) === "tools/weather.py");
  check("a run is short", labelFor("run", { run_id: "abcdef1234567890" }) === "run abcdef12");
  check("a case says so", labelFor("dataset_case", { name: "empty-city" }) === "case: empty-city");
  check("a commit is seven characters", labelFor("github", { commit_sha: "a1b2c3d9f8e7" }) === "commit a1b2c3d");
  check("a PR is its number", labelFor("github", { pr: 12 }) === "PR #12");
  check("a file at a ref says both", labelFor("github", { path: "a.py", ref: "main" }) === "a.py @ main");
  // Nothing returns an empty string — a chip with no label is a chip nobody can remove on purpose.
  for (const kind of ATTACHMENT_KINDS) {
    check(`${kind} always has SOME label`, labelFor(kind, {}).length > 0, labelFor(kind, {}));
  }
}

// ---------------------------------------------------------------------------------------------
// AND THAT ANY OF IT IS EVER REACHED, which is what this whole feature was missing.
//
// Every assertion above was true of the shipped code and none of it ran on a real turn: the
// picker priced rows, the rail rendered them, the meter warned, the cap and the budget check both
// worked — and the line that sends them did not exist. `turn_attachments` held zero rows and
// `grep` for the route across the client found no match. The budget check was a check on a
// payload that was never going to leave the browser, and it BLOCKED THE SEND of the message.
//
// So this is a source audit rather than an arithmetic one, and it is here because this is the
// suite about attachments. It reads the dispatch: the refs arrive on the command, they are
// attached through the SAME function the HTTP route calls, and the stored rows are resolved into
// the prompt. Two of those three could be true with the feature still inert.
// ---------------------------------------------------------------------------------------------
console.log("\nthe attachments actually reach a turn, and the turn's prompt");
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(HERE, "index.ts"), "utf8");
  const turns = readFileSync(join(HERE, "http", "turns.ts"), "utf8");
  const relay = readFileSync(join(HERE, "wsRelay.ts"), "utf8");
  const client = readFileSync(join(HERE, "..", "..", "client", "src", "components", "BuildPane.tsx"), "utf8");

  // ONE IMPLEMENTATION OF THE RULES. The composer cannot use the route — at Send the turn does not
  // exist yet, so there is no id to address — so the dispatch attaches instead. What must not
  // happen is two versions of the cap, the re-measurement and the budget check, because the second
  // one is the one that forgets to re-measure and lets any request through by claiming to be small.
  check("attachTurn is exported for both callers", /export async function attachTurn\(/.test(turns));
  check(
    "...and the route calls it rather than keeping its own copy of the rules",
    /const \{ rows, budget \} = await attachTurn\(/.test(turns),
  );
  check(
    "...still re-measuring server-side rather than trusting the request",
    /deps\.attachables\(ctx, item\.agentId, item\.kind, "", 0\)/.test(turns),
  );
  check(
    "...and still checking the budget BEFORE the write",
    turns.indexOf("if (budget.level === \"over\")") < turns.indexOf("await deps.attachments.attach(ctx, turnId, resolved)"),
  );

  // THE REFS TRAVEL ON THE COMMAND, which is the shape §7's GitHub attachments already use.
  check("the four composer commands can carry attachments", (relay.match(/attachments\?: CommandAttachment\[\]/g) ?? []).length === 4);
  check("the composer sends them", /const attachRefs = attachments\.map\(/.test(client));
  // BOTH `sendPlanAgent` CALLS — a fresh brief and a revision of one. Counted rather than matched
  // once, because a revision is the same gesture to a user and the two calls are eleven lines
  // apart, which is exactly the distance at which one of them gets missed.
  check(
    `...on both plan commands (${(client.match(/sendPlanAgent\(.*attachRefs\)/g) ?? []).length} of 2)`,
    (client.match(/sendPlanAgent\(.*attachRefs\)/g) ?? []).length === 2,
  );
  check("...on the edit command", /sendEdit\(activeAgentId, trimmed, attachRefs\)/.test(client));
  check("...and on the explain command", /attachRefs,\s*\);/.test(client));
  check("...and clears them with the draft they belonged to", /setAttachments\(\[\]\);\s*\};/.test(client));

  // AND THE OTHER HALF: a persisted row nothing reads is a record, not a feature.
  check("the dispatch resolves the stored rows into a block", /async function resolveAttachmentBlock\(/.test(index));
  check("...reading them back from the store rather than from the request", /attachmentStore\.forTurn\(ctx, turnId\)/.test(index));
  const attachFn = /async function attachToTurn\([\s\S]*?\n\}/.exec(index)?.[0] ?? "";
  check("attachToTurn returns the block it just wrote", /return resolveAttachmentBlock\(ctx, agentId, turnId\)/.test(attachFn));
  // ALL FOUR DISPATCH SITES, because three of four is a feature that works depending on how the
  // message was phrased — a brief, a revision, an edit and a question are one gesture to a user.
  check(
    `every composer dispatch appends it (${(index.match(/await attachToTurn\(/g) ?? []).length} of 4)`,
    (index.match(/await attachToTurn\(/g) ?? []).length === 4,
  );

  // A REFUSAL IS NOT A FAILED DISPATCH. The message has been sent; failing the run because a chip
  // did not fit would be a worse answer than answering without it.
  check("a refusal is caught and reported rather than thrown", /console\.error\(`\[attachments\] could not attach/.test(index));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

// §15 — the two escape hatches, and the conditions each appears under.
//
// §15's STANDARD: "the router will be wrong sometimes. That is acceptable IF BEING WRONG COSTS ONE
// CLICK." So both directions exist, both are one press, and both send the ORIGINAL message rather
// than something derived from it.
//
// WHY THIS IS A SOURCE-READING SUITE. Both affordances are `ChoiceRow` options built inside
// `BuildPane`'s render, gated by a chain of `else if` over live store state — there is no pure
// function to call, and the properties that matter are about WHICH branch they live in and WHAT
// they send. Those are facts about the text:
//
//   §15.1's CARD MUST NOT APPEAR ON EVERY REPLY. "Not on every chat reply, which would be noise."
//   The gate is `planEvidence === "near"`, and a gate on anything weaker — the route being chat, a
//   reply existing — would put it under every answer in the product.
//
//   AND NEITHER MAY SEND THE REPLY. §15.1: "the original user message… not the assistant's reply
//   and not a paraphrase." A `turn.text` reaching either dispatch is the one mistake that would
//   look completely plausible in review.
//
//   §15.2 MUST NOT DESTROY THE RECORD. "The plan was produced and paid for; that stays in the
//   record, consistent with this product never destroying a record as a side effect."
//
//   npm run test:escape-hatches

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** Source with its prose blanked, line count preserved — `deadControls.test.ts`'s helper. */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/.*$/gm, blanked);
}
const pane = strip(readFileSync(`${HERE}BuildPane.tsx`, "utf8"));

/** The body of one `ChoiceRow` option, by its id. */
function choice(id: string): string {
  const at = pane.indexOf(`id: "${id}"`);
  if (at < 0) return "";
  // To the next option's `id:` or the end of the choices array — enough to hold one `onPick`.
  const rest = pane.slice(at + 1);
  const next = rest.search(/\n\s*(\{\s*\n\s*)?id: "/);
  return next < 0 ? rest.slice(0, 1600) : rest.slice(0, next);
}

// --- §15.1: chat → build ----------------------------------------------------------------------

console.log("\n§15.1 — the build offer");
{
  check("the card exists", pane.includes('id: "build"'), "");
  // THE GATE. §15.1: "shown only when the router's confidence for plan was close to the threshold."
  check("it is gated on the near band", /planEvidence === "near"/.test(pane), "");
  // AND ONLY ON A FINISHED ANSWER — an offer under a reply still arriving is a decision about
  // something nobody has read.
  check("...and on a settled turn",
    /t\.status === "done" \|\| t\.status === "stopped"/.test(pane), "");
  // IT IS A `ChoiceRow` OPTION, which §15.1 names — "no new component".
  check("it is a ChoiceRow option", /const nearMiss/.test(pane) && pane.includes("ChoiceRow"), "");

  const build = choice("build");
  check("there is an onPick to read", build.includes("onPick"), "");
  // §15.1: THE ORIGINAL USER MESSAGE. `askedWith` is what the turn remembered, which is the only
  // source that is right on a regenerated turn — walking back through the thread would find the
  // question one turn further back than it looks.
  check("it sends the message the turn was asked with", /askedWith/.test(build), build.slice(0, 200));
  check("...to the plan route", /sendPlanAgent\(/.test(build), build.slice(0, 200));
  // THE ONE MISTAKE THAT WOULD LOOK PLAUSIBLE IN REVIEW.
  check("...and never the assistant's reply", !/\.text\b/.test(build), build.slice(0, 300));
  check("...nor whatever is in the composer now", !/\btrimmed\b|\btext\b/.test(build), build.slice(0, 300));
}

// --- §15.2: plan → chat -----------------------------------------------------------------------

console.log("\n§15.2 — the chat offer on an unwanted plan");
{
  check("the card exists", pane.includes('id: "just-asking"'), "");
  const ask = choice("just-asking");
  check("there is an onPick to read", ask.includes("onPick"), "");
  // §15.2: IT REUSES THE EXISTING DISCARD PATH.
  check("it discards the plan through the existing path", /sendDiscardPlan\(/.test(ask), ask.slice(0, 200));
  // ...AND ROUTES THE SAME MESSAGE TO CHAT. One click, which is §15's standard.
  check("...and sends the same message to chat", /sendChat\(asked/.test(ask), ask.slice(0, 300));
  check("...verbatim, from the plan's own brief", /const asked = openPlan\.prompt/.test(ask), ask.slice(0, 200));

  // §15.2: IT DOES NOT DELETE THE TURN OR HIDE WHAT HAPPENED. Asserted as an absence, which is the
  // only way: there is no delete to call, and `sendDiscardPlan` marks the card rather than removing
  // it — so the conversation keeps the plan, its cost and the answer that followed.
  check("it deletes nothing", !/delete|remove|splice|filter\(/i.test(ask), ask.slice(0, 300));

  // AND §15.1's CARD MUST NOT THEN APPEAR UNDER THE ANSWER. The message scored well enough to reach
  // the plan route, so its band would be `confident` — and offering to build it again one click
  // after somebody said they did not want that is the noise §15.1 is written to avoid.
  check("...and it suppresses the build offer on the answer", /planEvidence: "none"/.test(ask), ask.slice(0, 400));
}

// --- both directions exist, and only one fork shows at a time --------------------------------

console.log("\n§15 — being wrong costs one click, in both directions");
{
  // ONE FORK AT A TIME, which the `else if` chain is: a decision WAITING on somebody — a plan to
  // generate, a stale plan, a diff to apply, a failed step — outranks an offer about a finished
  // answer. §15.1's card is last in that chain for exactly that reason.
  const chain = pane.slice(pane.indexOf("let fork:"), pane.indexOf('id: "explain"'));
  const branches = (chain.match(/\n\s*\} else if \(/g) ?? []).length;
  check(`the fork slot holds one at a time (${branches} alternatives)`, branches >= 3, String(branches));
  // ANCHORED ON THE BRANCH, NOT THE IDENTIFIER. `nearMiss` is computed above the chain — it has to
  // be, the chain reads it — so searching for the name found the declaration and said the offer came
  // first. What is being asserted is where the BRANCH sits.
  check("...and the near-miss offer is the last alternative",
    chain.indexOf("} else if (nearMiss)") > chain.indexOf('openPlan?.planId && openPlan.status === "stale"'),
    `${chain.indexOf("} else if (nearMiss)")} vs ${chain.indexOf('openPlan?.planId && openPlan.status === "stale"')}`);
  // §13 IS WHAT MAKES THESE DISCOVERABLE, and §15 says so: "the user can see the route was chosen,
  // so a control to change it makes sense." The band that gates §15.1 is the same one §13's line is
  // drawn from, so they cannot disagree about what the router decided.
  check("the band the card reads is the one the router produced",
    /planEvidence: routing\.planEvidence/.test(pane), "");
}


// --- §16's pass: the keyboard asks the same question the row does -----------------------------
//
// `canRerunTurn` answers "is this the KIND of turn that can be re-run" and says where the other
// half lives: "a `streaming` one is excluded AT THE ROW rather than here, because that is a liveness
// question." `TurnActions` renders Regenerate under `!streaming`, so the button declines a turn that
// is still arriving. The keydown handler asked only `canRerunTurn`, so `R` on the streaming turn
// dispatched a regeneration the server then refused as a second message in a live conversation —
// one action, two paths, two answers, and the visible control was the one that was right.

console.log("\n§16 — R cannot regenerate a turn that is still arriving");
{
  const at = pane.indexOf("selectedIsRegenerable:");
  check("the keydown handler computes it", at > 0, String(at));
  const expr = pane.slice(at, at + 400);
  check("...from canRerunTurn", /canRerunTurn\(sel\)/.test(expr), expr.slice(0, 160));
  // THE LIVENESS HALF, in the same expression. Asserted as the property rather than as a string:
  // what matters is that a streaming reply is excluded, however that is spelled.
  check("...and excludes a streaming reply",
    /status\s*===\s*"streaming"/.test(expr) && /!\(|!==/.test(expr), expr.slice(0, 260));
  // AND THE ROW'S OWN GATE IS STILL THERE, so the two paths cannot drift apart again silently.
  const actions = strip(readFileSync(`${HERE}composer/TurnActions.tsx`, "utf8"));
  check("the row still hides Regenerate while streaming",
    /\{!streaming && onRegenerate &&/.test(actions));
  check("...and Regenerate-with too", /\{!streaming && onRegenerateWith &&/.test(actions));
}


// --- §16.1's DESKTOP ROW: offline send ---------------------------------------------------------
//
// THE ATTACK: press Send with no connection. `submit` returns early on `!connected`, so nothing
// phantom is appended to the thread and the draft is not cleared — that half was already right.
// What was missing was the sentence: Send disables on `!connected` beside `overBudget` and
// `missingKey`, each of which had a notice, and this one had none. So a dropped socket left a greyed
// arrow whose tooltip still promised a route, which is the mismatch §3.4 paid for once already and
// the standard the button's own comment states: "a disabled button is never unexplained."
//
// BOTH GUARDS PREDATE THIS FEATURE. Running the attack is what surfaced them.

console.log("\n§16 — a disabled Send says why");
{
  check("the draft survives an offline press",
    /if \(!connected \|\| !trimmed\) return;/.test(pane), "submit's early return");
  // THE NOTICE, and it is a `role="status"` line like the budget one rather than a new mechanism.
  const at = pane.indexOf("{!connected && (");
  check("a notice renders when disconnected", at > 0, String(at));
  const notice = pane.slice(at, at + 700);
  check('...as role="status"', /role="status"/.test(notice), notice.slice(0, 200));
  check("...saying the draft is kept", /draft is kept/.test(notice), notice.slice(0, 400));
  // AND THE BUTTON ITSELF, checked ahead of the key and the mode — the order matters, because
  // `missingKey` is false on a fresh disconnect and would otherwise win the ternary.
  check("the button's label names it first",
    /aria-label=\{!connected \? OFFLINE_SEND/.test(pane), "aria-label order");
  check("...and so does its tooltip", /title=\{!connected \? OFFLINE_SEND/.test(pane), "title order");
  check("...from one string, so hover and screen reader agree",
    (pane.match(/OFFLINE_SEND/g) ?? []).length === 3, String((pane.match(/OFFLINE_SEND/g) ?? []).length));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

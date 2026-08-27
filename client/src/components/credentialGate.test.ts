// A CREDENTIAL SENT TO THE SERVER TO FIND OUT WHETHER IT COULD BE SENT.
//
// The Inbox's *…needs ZENDESK_TOKEN* card enables Save the moment its field is non-empty. With
// Secrets locked, pressing it POSTed the value:
//
//   POST /v1/secrets?workspace=… {"name":"ZENDESK_TOKEN","value":"…","kind":"custom"}  → 403
//
// and only then rendered "this needs an unlocked Secrets session" beside the button. The refusal is
// correct, the message is correct and it appears in the right place — the whole defect is that the
// precondition was discovered by transmitting the thing it guards.
//
// IT IS THE ONE PLACE IN THE APP WHERE THAT HAPPENS, which is what makes it worth a suite rather
// than a one-line change and nothing else. Every other disabled control in this client carries its
// reason before you press it: "Select an agent to deploy", "This deployment has no google OAuth app
// configured", "This plan no longer matches the selected connectors — re-plan first". The gate state
// was already knowable, so this row was the exception rather than the rule.
//
// THE ASSERTION ABOUT THE UNKNOWN STATE IS THE LOAD-BEARING ONE. `gateLoaded` false means the
// question has not been answered, not that the vault is locked — and a control disabled by a request
// that failed is a form nobody can submit for a reason nobody can see, which is worse than the 403.
//
//   npm run test:credential-gate

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS = readFileSync(`${HERE}InboxCardActions.tsx`, "utf8");

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe precondition is part of the disabled predicate");
{
  check("Save is disabled while the vault is locked", /disabled=\{busy \|\| !value\.trim\(\) \|\| locked\}/.test(ACTIONS),
    "the button still enables on a non-empty field alone");
  // Enter submits from the field too, so the guard has to be in the submit path as well or the
  // keyboard route still transmits.
  check("...and Enter cannot get past it", /if \(!value\.trim\(\) \|\| busy \|\| locked\) return;/.test(ACTIONS));
}

console.log("\nthe reason is attached to the control, not discovered after it");
{
  check("the sentence is a constant used in both places", ACTIONS.includes("const lockedReason ="));
  check("...on the button's title", /title=\{locked \? lockedReason : undefined\}/.test(ACTIONS));
  // A `title` alone is unreachable by keyboard — which is exactly how somebody arrives at a control
  // they cannot use — and `disabled:pointer-events-none` means a disabled button shows none anyway.
  check("...and as visible text under the field", /\{locked && \(/.test(ACTIONS));
  // A disabled control cannot also be its own fix, which is the argument the model selector's
  // "Add key" already makes.
  check("the way out is beside it", ACTIONS.includes('setRightTab("secrets")'));
}

console.log("\nan unknown gate disables nothing");
{
  check("locked requires the gate to have been read", /const locked = !isCeiling && gateLoaded && !elevated;/.test(ACTIONS),
    "an unread gate can disable the form");
  // The fetch is caught and swallowed on purpose: a gate state that could not be read leaves the
  // server as the authority, which is exactly the behaviour this replaces.
  check("a failed elevation read is swallowed", /catch \{/.test(ACTIONS));
}

console.log("\nthe form asks for the gate itself rather than assuming somebody else did");
{
  // `SecretsPanel` polls elevation, and it is mounted only while the Secrets tab is the one
  // showing. This form lives on the Inbox, where it usually is not.
  check("it fetches the elevation state", ACTIONS.includes("fetchElevation()"));
  check("...once, and only when it does not already have it", /if \(isCeiling \|\| gateLoaded\) return;/.test(ACTIONS));
  // The ceiling card posts no secret and needs no elevation; gating it would disable a control for
  // a precondition that does not apply to it.
  check("the ceiling card is never gated by it", /!isCeiling && gateLoaded/.test(ACTIONS));
}

console.log("\nand the value still never enters a store");
{
  // The discipline the card already kept, which this change must not quietly undo on its way to
  // reading one more piece of state.
  check("the credential is component state, handed straight to the request",
    ACTIONS.includes("const [value, setValue] = useState(\"\")"));
  check("...and the field is cleared the moment it is sent", ACTIONS.includes('setValue("")'));
  check("...and it is a password field", /type=\{isCeiling \? "text" : "password"\}/.test(ACTIONS));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

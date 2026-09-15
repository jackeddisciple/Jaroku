// The one vocabulary a subscription row's state is spoken in — the model menu and Settings.
//
// THE DEFECT: the model menu's Chat section labelled every model it could not use "no API key", in the
// section where an API key is explicitly not the credential. The tooltip said "run `codex login`"; the
// badge beside it said the opposite and pointed at Secrets.
//
//   npm run test:subscription-state

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { subscriptionBadge, subscriptionBlockedReason, subscriptionState } from "./subscriptionState.ts";
import type { SubscriptionStatus } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A Codex row as the server sends one, with nothing reported by the machine yet. */
const row = (over: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  provider: "openai", label: "Codex", planLabel: "ChatGPT",
  available: true, supported: true, requiresApproval: false, runtimeApiSupported: true,
  reason: null, citation: "https://learn.chatgpt.com/docs/app-server", unblock: null,
  effortParam: "model_reasoning_effort", effortLevels: ["low", "medium", "high", "xhigh"],
  binary: "codex", loginCommand: "codex login", credentialPath: "~/.codex/auth.json",
  host: null, connected: false,
  ...over,
});
const host = (over: Partial<NonNullable<SubscriptionStatus["host"]>> = {}): NonNullable<SubscriptionStatus["host"]> => ({
  installed: true, version: "0.154.0", signedIn: false, account: null, authMode: null, note: null,
  observedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

console.log("\neach state, in one word");
{
  const connected = row({ connected: true, host: host({ signedIn: true }) });
  check("connected is connected", subscriptionState(connected) === "connected");
  check("...and carries no badge", subscriptionBadge(connected) === null, String(subscriptionBadge(connected)));
  check("nothing reported reads as not installed", subscriptionState(row()) === "missing");
  check("...and is badged so", subscriptionBadge(row()) === "not installed", String(subscriptionBadge(row())));
  const signedOut = row({ host: host() });
  check("installed and signed out", subscriptionState(signedOut) === "signed-out");
  check("...is badged not signed in", subscriptionBadge(signedOut) === "not signed in", String(subscriptionBadge(signedOut)));
  const gated = row({
    provider: "meta", label: "Muse Spark", available: false, supported: false,
    reason: "Meta documents no way for a third-party application to drive Muse Code.", binary: null, loginCommand: null,
  });
  check("a provider that permits nothing is unavailable", subscriptionState(gated) === "unavailable");
  check("...whatever the machine reports", subscriptionState({ ...gated, host: host({ signedIn: true }) }) === "unavailable");
  check("a row that never arrived is not connected", subscriptionBadge(undefined) === "not connected");
}

console.log("\nno Chat badge or reason speaks of an API key");
{
  const rows = [row(), row({ host: host() }), row({ available: false, reason: "not permitted" }), undefined];
  for (const r of rows) {
    const words = `${subscriptionBadge(r) ?? ""} ${subscriptionBlockedReason(r)}`;
    check(`"${subscriptionBadge(r)}" never mentions an API key`, !/api key/i.test(words), words);
  }
}

console.log("\nthe reason says what to do about it");
{
  check("signed out names the provider's own sign-in",
    subscriptionBlockedReason(row({ host: host() })) === "Run `codex login` to sign in with your plan.",
    subscriptionBlockedReason(row({ host: host() })));
  const apiKeyNote = "Codex is signed in with API credentials rather than a ChatGPT plan.";
  check("...unless the shell said why it is refused, which is said instead",
    subscriptionBlockedReason(row({ host: host({ authMode: "apikey", note: apiKeyNote }) })) === apiKeyNote);
  check("not installed names the binary", /^codex isn't installed/.test(subscriptionBlockedReason(row())));
  check("unavailable is the provider's own reason, verbatim",
    subscriptionBlockedReason(row({ available: false, reason: "Meta documents no way." })) === "Meta documents no way.");
}

console.log("\nthe model menu's Chat section speaks this vocabulary");
{
  const pane = readFileSync(fileURLToPath(new URL("../components/BuildPane.tsx", import.meta.url)), "utf8");
  // The Test section keeps its badge — a run does spend an API account — and the Chat section passes
  // the subscription's word rather than inheriting that one.
  check("the Chat section passes its own badge", /blockedBadge=\{\(id\) => subscriptionBadge\(/.test(pane));
  check("...and its reason from the same module", /blockedReason=\{\(id\) => subscriptionBlockedReason\(/.test(pane));
  const settings = readFileSync(fileURLToPath(new URL("../components/ProviderSubscriptions.tsx", import.meta.url)), "utf8");
  check("Settings derives a row's state from the same function", /subscriptionState\(row\)/.test(settings));
}

console.log("\na provider with a mechanism but no permission yet is listed, as unavailable");
{
  // THE SETTINGS BRANCH THAT READS AS DEAD. The list keeps every SUPPORTED provider, and supported is not
  // available: a finished integration awaiting the provider's approval — Claude, until 2026-09-13 — is the
  // first and not yet the second. Nothing takes that branch today, and something will again.
  const awaiting = row({
    available: false, requiresApproval: true, reason: "Awaiting the provider's approval.",
    host: host({ signedIn: true }),
  });
  check("a supported row awaiting approval is unavailable, however set up the machine is", subscriptionState(awaiting) === "unavailable");
  check("...and says so in the provider's own words", subscriptionBlockedReason(awaiting) === "Awaiting the provider's approval.");
  const settings = readFileSync(fileURLToPath(new URL("../components/ProviderSubscriptions.tsx", import.meta.url)), "utf8");
  check("Settings keeps supported rows rather than only available ones", /all\.filter\(\(r\) => r\.supported\)/.test(settings));
  check("...and draws the unavailable branch for them", /state === "unavailable" \? \(/.test(settings));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

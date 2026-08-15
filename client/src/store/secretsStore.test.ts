// The Secrets store, and the three rules in it that are decisions rather than plumbing.
//
//   LOCKING DROPS THE LIST — but only under the `tab` policy. A locked tab still holding the rows
//   would keep rendering what a workspace integrates with after the gate closed, which is the
//   entire thing the gate is for, defeated by a stale array. Under `mutations` the list is
//   legitimately readable while locked, so it has to SURVIVE there. One field, two behaviours, and
//   getting them the wrong way round is invisible until somebody looks at a locked tab.
//
//   A PENDING ACTION SURVIVES A LOCK. That is what it is for: the brief asks that an expiry mid-form
//   hold the user's input and resume after unlocking, because "losing a half-typed secret to a
//   timer is a self-inflicted wound". A `setElevation` that cleared it would be exactly that wound.
//
//   THE COUNTDOWN STOPS AT ZERO AND LOCKS. Not negative, and not still claiming to be elevated
//   while the number reads 0:00.
//
// And one absence asserted rather than assumed: no secret VALUE and no elevation TOKEN is in this
// store, because a store is what devtools serialise and error reporters attach.
//
//   npm run test:secrets-store

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  formatRemaining,
  groupSecrets,
  isFinalMinute,
  holdForElevation,
  needsAttention,
  useSecretsStore,
} from "./secretsStore.ts";
import type { SecretSummary } from "../lib/secrets.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const reset = (): void => useSecretsStore.setState(useSecretsStore.getInitialState(), true);

const secret = (over: Partial<SecretSummary>): SecretSummary => ({
  name: "A_KEY",
  kind: "custom",
  provider: null,
  scope: "workspace",
  agentId: null,
  configured: true,
  maskedHint: "••••••••",
  status: "unknown",
  expiresAt: null,
  lastUsedAt: null,
  rotatedAt: null,
  connectorId: null,
  rotateEveryDays: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

console.log("\nlocking and the list");
{
  reset();
  const s = () => useSecretsStore.getState();
  s().setSecrets([secret({ name: "ONE" }), secret({ name: "TWO" })]);
  s().setElevation({ elevated: true, expiresAt: "2026-08-14T13:00:00.000Z", remainingMs: 600_000, passcodeSet: true, gate: "tab" });
  check(s().secrets.length === 2, "an unlocked tab holds the list");

  s().setElevation({ elevated: false, expiresAt: null, remainingMs: 0, passcodeSet: true, gate: "tab" });
  check(s().secrets.length === 0, "locking under 'tab' drops it, so a locked tab renders nothing");
  check(s().loaded === false, "...and forgets it had loaded, so the next unlock refetches");

  // The other half, which is the one a single-behaviour implementation gets wrong.
  reset();
  s().setSecrets([secret({ name: "ONE" })]);
  s().setElevation({ elevated: false, expiresAt: null, remainingMs: 0, passcodeSet: true, gate: "mutations" });
  check(s().secrets.length === 1, "under 'mutations' the list survives a lock, because it is readable there");
}

console.log("\na pending action outlives the lock it was interrupted by");
{
  reset();
  const s = () => useSecretsStore.getState();
  let resumed = false;
  s().setPending({ label: "add OPENWEATHER_API_KEY", run: async () => void (resumed = true) });
  s().setElevation({ elevated: false, expiresAt: null, remainingMs: 0, passcodeSet: true, gate: "tab" });
  check(s().pending !== null, "an expiry does not discard what the user was in the middle of");
  check(s().pending?.label.includes("OPENWEATHER") === true, "...and it still says what it was");

  s().setElevation({ elevated: true, expiresAt: "2026-08-14T13:00:00.000Z", remainingMs: 600_000, passcodeSet: true, gate: "tab" });
  check(s().pending !== null, "and unlocking does not discard it either — the caller replays it");
  void s().pending?.run();
  check(resumed, "which is a thunk, so the form's own values go with it rather than being retyped");
}

console.log("\nand something actually puts one there");
{
  // The half that was missing: the slot, the lock screen's "Unlock to finish: …" and the replay all
  // existed, and no code path ever called setPending. Every refused mutation surfaced as an error
  // strip while the form carrying the typed credential unmounted behind the lock screen.
  const s = () => useSecretsStore.getState();
  const refused = (code: string): Error => Object.assign(new Error("this needs an unlocked Secrets session"), { code });

  reset();
  let attempts = 0;
  const applied = await holdForElevation("add OPENWEATHER_API_KEY", async () => {
    attempts++;
    if (attempts === 1) throw refused("elevation_required");
  });
  check(applied === false, "a mutation refused for want of elevation reports that it did not run");
  check(s().pending?.label === "add OPENWEATHER_API_KEY", "and is parked under a label the lock screen can render");
  check(s().error === null, "without an error strip, because nothing has gone wrong yet");

  await s().pending?.run();
  check(attempts === 2, "replaying it re-runs the same attempt");

  reset();
  let ran = false;
  const ok = await holdForElevation("add ANOTHER", async () => void (ran = true));
  check(ok === true && ran && s().pending === null, "a mutation that succeeds parks nothing");

  reset();
  let threw = false;
  try {
    await holdForElevation("add REJECTED", async () => {
      throw Object.assign(new Error("that credential was not accepted"), { code: "credential_rejected" });
    });
  } catch {
    threw = true;
  }
  check(threw, "a rejected credential still throws — that is a message the user needs now");
  check(s().pending === null, "and is not parked, because unlocking would not make it any more valid");
}

console.log("\nthe countdown");
{
  reset();
  const s = () => useSecretsStore.getState();
  const expires = "2026-08-14T12:10:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  s().setElevation({ elevated: true, expiresAt: expires, remainingMs: 600_000, passcodeSet: true, gate: "tab" });

  s().tick(at("2026-08-14T12:03:48.000Z"));
  check(s().remainingMs === 372_000, "counts down from a clock the caller owns", String(s().remainingMs));
  check(formatRemaining(s().remainingMs) === "6:12", "and renders as minutes and seconds", formatRemaining(s().remainingMs));
  check(s().elevated === true, "still elevated with time on it");

  s().tick(at("2026-08-14T12:10:30.000Z"));
  check(s().remainingMs === 0, "past the expiry it stops at zero rather than going negative");
  check(s().elevated === false, "...and stops claiming to be elevated, so the UI locks on the timer");
  check(formatRemaining(0) === "0:00", "which renders as 0:00");
  check(formatRemaining(-5_000) === "0:00", "and a negative is clamped rather than rendered");
}

console.log("\nthe final minute is not signalled by colour alone");
{
  check(isFinalMinute(61_000) === false, "sixty-one seconds is not the final minute");
  check(isFinalMinute(60_000) === true, "sixty is");
  check(isFinalMinute(1) === true, "and so is one millisecond");
  // Zero is expired rather than "final minute" — the lock screen is showing by then, and an amber
  // pulse on a locked tab would be a warning about nothing.
  check(isFinalMinute(0) === false, "zero is expired, not a final minute");
}

console.log("\ngrouping and the badge");
{
  const all = [
    secret({ name: "ANTHROPIC_API_KEY", kind: "provider_key" }),
    secret({ name: "GITHUB_TOKEN", kind: "managed" }),
    secret({ name: "OPENWEATHER_API_KEY", kind: "custom" }),
    secret({ name: "STRIPE_SECRET_KEY", kind: "custom" }),
  ];
  const grouped = groupSecrets(all);
  check(grouped.providers.length === 1, "provider keys group together");
  check(grouped.managed.length === 1, "connector-managed ones separately");
  check(grouped.custom.length === 2, "and custom ones separately again");
  check(
    grouped.providers.length + grouped.managed.length + grouped.custom.length === all.length,
    "with every credential in exactly one group, so none is invisible",
  );

  check(needsAttention(null) === false, "no health yet is not a warning");
  check(needsAttention({ total: 3, expiringSoon: 0, invalid: 0, rotationDue: 0, unusedNinetyDays: 2 }) === false,
    "an unused credential is not a warning — it is information, and a permanent dot is no dot");
  check(needsAttention({ total: 3, expiringSoon: 1, invalid: 0, rotationDue: 0, unusedNinetyDays: 0 }) === true,
    "something expiring is");
  check(needsAttention({ total: 3, expiringSoon: 0, invalid: 1, rotationDue: 0, unusedNinetyDays: 0 }) === true,
    "and so is something broken");
}

// --- the absences, asserted against the source ------------------------------------------------
//
// A structural check rather than a behavioural one, because what is being defended is that a field
// is never ADDED. The failure this catches is somebody putting the revealed value in the store "so
// the dialog can re-render", six months from now, with no test that notices.
console.log("\nwhat this store must never hold");
{
  const storeSource = readFileSync(fileURLToPath(new URL("./secretsStore.ts", import.meta.url)), "utf8");
  const state = JSON.stringify(useSecretsStore.getState());
  check(!/\bvalue\s*:/.test(storeSource.replace(/\/\/[^\n]*/g, "")), "no field called `value` in the state");
  check(
    !/elevationToken|token\s*:/.test(storeSource.replace(/\/\/[^\n]*/g, "")),
    "and no elevation token — it lives in a module variable in lib/secrets.ts, out of devtools' reach",
  );
  check(!state.includes("\"token\""), "and a serialised snapshot of the store carries neither");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

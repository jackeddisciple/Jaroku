// The derivation, and the one ordering it must never get wrong.
//
// Two inputs decide a row: what the provider permits, and what the machine has. The dangerous
// arrangement is the natural-looking one — check the machine, and treat permission as a detail —
// because it produces a product that works on the laptop of anybody who already has the CLI, and
// breaks a provider's terms for exactly those users. So the suite spends most of its assertions on
// the case where the machine is perfect and the answer is still no.
//
//   npm run test:provider-auth-status

import { PROVIDER_IDS, type ProviderId } from "../providers.ts";
import { capabilityOf, subscriptionAvailable } from "./capability.ts";
import {
  connectedProviders, statusFor, subscriptionStatuses, type HostObservation,
} from "./status.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A machine with everything the provider could want: installed, current, signed in. */
const perfect = (provider: ProviderId): HostObservation => ({
  provider,
  installed: true,
  version: "1.0.0",
  signedIn: true,
  account: "someone@example.com",
  authMode: "chatgpt",
  note: null,
  observedAt: "2026-09-13T00:00:00.000Z",
});

const installedOnly = (provider: ProviderId): HostObservation => ({
  ...perfect(provider), signedIn: false, account: null,
});

const absent = (provider: ProviderId): HostObservation => ({
  ...perfect(provider), installed: false, version: null, signedIn: false, account: null,
});

console.log("\npermission is checked before the machine, and outranks it");
{
  for (const id of PROVIDER_IDS) {
    const row = statusFor(id, perfect(id));
    if (subscriptionAvailable(id)) {
      check(`${id} connects when permitted and set up`, row.connected);
    } else {
      // THE ASSERTION THIS FILE EXISTS FOR.
      check(`${id} stays refused on a perfectly set-up machine`, !row.connected);
      check(`...and still explains why`, (row.reason ?? "").length > 40);
    }
  }
}

console.log("\nan available provider still needs the machine");
{
  const id: ProviderId = "openai";
  check("not installed is not connected", !statusFor(id, absent(id)).connected);
  check("installed but signed out is not connected", !statusFor(id, installedOnly(id)).connected);
  check("nothing reported at all is not connected", !statusFor(id, undefined).connected);
  check("...and that row says nothing has reported", statusFor(id, undefined).host === null);
}

console.log("\na row carries what the UI needs to explain itself");
{
  const openai = statusFor("openai", perfect("openai"));
  check("an available row names the binary", openai.binary === "codex");
  check("...the sign-in command", openai.loginCommand === "codex login");
  check("...where the credential lives", openai.credentialPath === "~/.codex/auth.json");
  check("...and cites the page that sanctions it", /^https:\/\//.test(openai.citation));
  const refusal = "Codex is signed in with API credentials rather than a ChatGPT plan.";
  const refused = statusFor("openai", { ...installedOnly("openai"), authMode: "apikey", note: refusal });
  check("...and the shell's own sentence for a refusal", refused.host?.note === refusal, String(refused.host?.note));
  check("...beside the mode it explains", refused.host?.authMode === "apikey");

  const anthropic = statusFor("anthropic", undefined);
  check("Claude names its binary", anthropic.binary === "claude");
  check("...and Anthropic's own sign-in command", anthropic.loginCommand === "claude auth login");
  check("...where the credential lives, which nothing here opens", anthropic.credentialPath?.includes("Keychain") === true);
  check("...and is available, with nothing to explain away", anthropic.available && anthropic.reason === null);

  // THE GATED CASE IS MUSE SPARK NOW, and the assertions move with it rather than disappearing: a
  // provider with no documented third-party mechanism must still render a row that explains itself,
  // because the question "can I use my Muse subscription?" deserves an answer rather than silence.
  const meta = statusFor("meta", perfect("meta"));
  check("a gated row carries no mechanism to offer", meta.binary === null && meta.loginCommand === null);
  check("...says no official mechanism exists", !meta.supported && !meta.available);
  check("...explains why, in the provider's own terms", (meta.reason ?? "").length > 40);
  check("...cites the page it was refused by", /^https:\/\//.test(meta.citation));
  check("...and stays refused on a machine set up for it", !meta.connected);
}

console.log("\nevery provider gets a row, gated ones included");
{
  const rows = subscriptionStatuses(PROVIDER_IDS, new Map());
  check("one row per provider", rows.length === PROVIDER_IDS.length);
  check("...in the providers' own order", rows.map((r) => r.provider).join(",") === PROVIDER_IDS.join(","));
  // Hiding a gated provider answers "can I use my Muse subscription?" with silence.
  check("...and gated providers are present rather than hidden", rows.some((r) => !r.available));
  check("every row is labelled for a person", rows.every((r) => r.label.length > 0 && r.label !== r.provider));
  // Agent runtime is a separate credential system and no subscription verdict may narrow it.
  check("...and every row still runs agents on an API key", rows.every((r) => r.runtimeApiSupported));
}

console.log("\nthe connectable set is what dispatch and the selector both read");
{
  const all = new Map(PROVIDER_IDS.map((id) => [id, perfect(id)] as const));
  const rows = subscriptionStatuses(PROVIDER_IDS, all);
  const connected = connectedProviders(rows);
  // Every machine set up for all three; only the PERMITTED ones come back. Muse Spark is reported
  // installed and signed in here and is still absent, which is the whole property: the machine
  // never overrules the provider.
  check("only permitted providers connect", connected.join(",") === "anthropic,openai", connected.join(","));
  check("...which is exactly the available set", connected.every((id) => subscriptionAvailable(id)));
  check("...and the unsupported one is left out despite being set up", !connected.includes("meta"));

  const none = connectedProviders(subscriptionStatuses(PROVIDER_IDS, new Map()));
  check("an empty machine connects nothing", none.length === 0);
}

console.log("\nhost facts are facts, not credentials");
{
  const row = statusFor("openai", perfect("openai"));
  const serialised = JSON.stringify(row);
  // The row is sent to a browser. It may say WHICH account and WHERE the credential lives; it may
  // never carry the credential, and there is nothing in the observation shape that could hold one.
  check("a row carries no token-shaped field", !/token|secret|apiKey|api_key|password|bearer/i.test(serialised), serialised.slice(0, 120));
  check("...but does say which account", row.host?.account === "someone@example.com");
  check("...and when it was last looked at", typeof row.host?.observedAt === "string");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

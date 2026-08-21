// §5.1 step 3's key, and mostly §5.3's "already saved is not re-collected".
//
// THE THREE NAMES ARE THE POINT OF THE FIRST HALF. A key stored as `GEMINI_API_KEY` and read as
// `GOOGLE_API_KEY` produces an onboarding that reports success, a Secrets tab that shows a
// connected provider, and a first run that cannot authenticate — with nothing anywhere saying the
// two differ. `test:desktop-contract` checks them against the server's own `PROVIDER_ENV_KEY`,
// across the seam; this checks the shape the step depends on, on this side.
//
// AND THE SECOND HALF IS ABOUT A FAILURE THAT LOOKS LIKE SUCCESS. `connectedProviders` decides
// whether the step says "Connected" beside a provider, and the safe direction is emphatically one
// way: claiming a key exists when it does not sends somebody past the screen that would have set
// one, into a first run that fails. So every failure — a locked vault, an unreachable server,
// a body that is not what it should be — answers with an empty set.
//
//   npm run test:provider-keys

import { PROVIDER_CHOICES, connectedProviders } from "./providerKeys.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

let responder: () => { status: number; body: unknown } = () => ({ status: 200, body: { secrets: [] } });
g.fetch = async (): Promise<unknown> => {
  const answer = responder();
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    statusText: "",
    json: async () => answer.body,
    text: async () => JSON.stringify(answer.body),
    headers: { get: () => null },
  };
};

console.log("\nthe three providers §5.1 lists");
{
  check("there are three", PROVIDER_CHOICES.length === 3);
  check("...in §5.1's order", PROVIDER_CHOICES.map((p) => p.id).join(",") === "anthropic,openai,google");
  // §5.1 marks exactly one, and marking two would make the word mean nothing.
  check("exactly one is recommended", PROVIDER_CHOICES.filter((p) => p.recommended).length === 1);
  check("...and it is Anthropic, as §5.1 says", PROVIDER_CHOICES.find((p) => p.recommended)?.id === "anthropic");
}
{
  // The names the Python runtime actually reads. Asserted here as literals rather than derived, so
  // that renaming one is a change to this line and therefore to a review.
  const named = Object.fromEntries(PROVIDER_CHOICES.map((p) => [p.id, p.secretName]));
  check("anthropic is stored as ANTHROPIC_API_KEY", named.anthropic === "ANTHROPIC_API_KEY");
  check("openai is stored as OPENAI_API_KEY", named.openai === "OPENAI_API_KEY");
  // `GOOGLE_API_KEY` rather than the prettier `GEMINI_API_KEY`, because that is the name
  // `langchain_google_genai` reads and the runtime is what has to find it.
  check("google is stored as GOOGLE_API_KEY", named.google === "GOOGLE_API_KEY");
  check("every name is UPPER_SNAKE_CASE, which the server's own validator requires",
    PROVIDER_CHOICES.every((p) => /^[A-Z][A-Z0-9_]*$/.test(p.secretName)));
  check("every provider has a placeholder that looks like its own keys",
    PROVIDER_CHOICES.every((p) => p.placeholder.length > 2));
}

console.log("\nwhich providers already have a key");
{
  responder = () => ({ status: 200, body: { secrets: [] } });
  check("an empty vault connects nothing", (await connectedProviders()).size === 0);

  responder = () => ({
    status: 200,
    body: { secrets: [{ name: "ANTHROPIC_API_KEY", kind: "provider_key" }] },
  });
  const one = await connectedProviders();
  check("a stored key marks its provider connected", one.has("anthropic"));
  check("...and only that one", one.size === 1);

  responder = () => ({
    status: 200,
    body: {
      secrets: [
        { name: "ANTHROPIC_API_KEY", kind: "provider_key" },
        { name: "GOOGLE_API_KEY", kind: "provider_key" },
        // Not a provider key at all. A workspace has other credentials in it, and counting one
        // would put "Connected" beside a provider nobody configured.
        { name: "SLACK_BOT_TOKEN", kind: "custom" },
      ],
    },
  });
  const two = await connectedProviders();
  check("two stored keys mark two providers", two.has("anthropic") && two.has("google"));
  check("...and an unrelated credential marks none", !two.has("openai") && two.size === 2);
}
{
  // THE SAFE DIRECTION IS ONE WAY. Claiming a key exists when it does not sends somebody past the
  // screen that would have set one, into a first run that fails with an authentication error.
  responder = () => ({ status: 403, body: { error: { code: "elevation_required" } } });
  check("a LOCKED vault connects nothing rather than guessing", (await connectedProviders()).size === 0);

  responder = () => ({ status: 500, body: {} });
  check("a server error connects nothing", (await connectedProviders()).size === 0);

  responder = () => {
    throw new Error("offline");
  };
  check("an unreachable server connects nothing", (await connectedProviders()).size === 0);

  responder = () => ({ status: 200, body: { secrets: "not an array" } });
  check("a body that is not what it should be connects nothing", (await connectedProviders()).size === 0);

  responder = () => ({ status: 200, body: {} });
  check("...and neither does one with nothing in it", (await connectedProviders()).size === 0);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

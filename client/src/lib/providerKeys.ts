// §5.1 step 3's key, checked and then stored where the Secrets tab keeps one.
//
// THE THREE PROVIDERS ARE HERE AND NOT IN THE COMPONENT, because two things need the list: the step
// that renders the radio buttons, and the suite that asserts the ids match what the server's secret
// group actually accepts. A list inside a component is a list a suite has to render a component to
// read.
//
// IT WRITES THROUGH THE SECRETS PATH, NOT BESIDE IT. §5.1: this step "is effectively pre-populating
// the Secrets tab's Model Providers group". So the key goes to the same route, under the same name,
// with the same envelope encryption, the same masking and the same audit row — and somebody who
// sets one here and opens the Secrets tab tomorrow finds it where they would have put it. A
// separate onboarding-only slot would be a second place credentials live, which is the one thing
// the Secrets tab exists to stop.

import { createSecret } from "./secrets.ts";

/** §5.1's three, in the order it lists them. */
export const PROVIDER_CHOICES = [
  {
    id: "anthropic",
    label: "Anthropic",
    /**
     * MARKED RECOMMENDED BECAUSE §5.1 MARKS IT, and the honest reason is that it is the provider
     * the generation path is tuned against — a recommendation that means "this one is best tested
     * here" rather than "this one is best".
     */
    recommended: true,
    placeholder: "sk-ant-…",
    /** The name the vault files it under. Must match the Secrets tab's own group. */
    secretName: "ANTHROPIC_API_KEY",
  },
  { id: "openai", label: "OpenAI", recommended: false, placeholder: "sk-…", secretName: "OPENAI_API_KEY" },
  { id: "google", label: "Google", recommended: false, placeholder: "AIza…", secretName: "GOOGLE_API_KEY" },
] as const;

export type ProviderChoiceId = (typeof PROVIDER_CHOICES)[number]["id"];

/**
 * Store a provider key, which is the same request the Secrets tab makes.
 *
 * THE VALIDATION IS THE SERVER'S AND IT HAPPENS BEFORE THE WRITE. `POST /v1/secrets` runs the
 * cheapest possible authenticated call against the provider — a models-list — and answers 422
 * `credential_rejected` without storing anything when it fails. That ordering is the whole reason
 * this function is three lines rather than a validate-then-store dance: a key checked on this side
 * and stored on that one has a window between the two, and a key stored before it is checked is a
 * key somebody discovers is wrong on their first run, three screens later, with nothing on screen
 * connecting the two.
 *
 * THE PROVIDER'S OWN WORDS REACH THE SCREEN, sanitised by the server. "This key is revoked", "this
 * key belongs to a different organisation" and "this key has no billing set up" are three different
 * problems with three different fixes, and nothing on this side could tell them apart.
 *
 * `kind: "provider_key"` AND `provider` ARE WHAT MAKE IT APPEAR IN THE SECRETS TAB'S MODEL
 * PROVIDERS GROUP rather than as a loose custom value. §5.1 calls this step "effectively
 * pre-populating" that group, and these two fields are the whole of what "effectively" means.
 */
export async function saveProviderKey(provider: ProviderChoiceId, key: string): Promise<void> {
  const choice = PROVIDER_CHOICES.find((p) => p.id === provider);
  if (!choice) throw new Error(`${provider} is not a provider Jaroku knows about`);
  await createSecret({ name: choice.secretName, value: key, kind: "provider_key", provider: choice.id });
}

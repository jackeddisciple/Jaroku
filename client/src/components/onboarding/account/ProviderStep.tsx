// §5.1 step 3 — connect a model provider, or don't.
//
// "SKIP IS GENUINELY FIRST-CLASS HERE." The specification says it in bold and then says why: "A
// user who skips can still use the offline dry-run mode for their first agent, and can add a key
// later from the Secrets tab. The sample agent generated in Step 4 respects this." That sentence is
// the difference between this product and every other one that asks for an API key before it has
// shown you anything — and it is why the skip below is not apologetic.
//
// THE KEY IS VALIDATED LIVE AND IS NEVER STORED UNVALIDATED. The Secrets tab's own rule, quoted:
// "make a cheapest-possible authenticated call (models-list), success → checkmark and store,
// failure → do not store, show provider error verbatim-but-sanitized." A key stored before it is
// checked is a key somebody discovers is wrong on their first run, three screens later, with
// nothing on screen to connect the two.
//
// AND IT GOES INTO THE SAME PLACE THE SECRETS TAB WRITES. This step is "effectively pre-populating
// the Secrets tab's Model Providers group" — not a second store, not a special onboarding-only
// slot. Somebody who sets a key here and opens the Secrets tab tomorrow finds it where they would
// have put it, with the same masking, the same rotation history and the same audit trail.

import { useState } from "react";
import { HELP_URLS, openExternal } from "../../../lib/openExternal.ts";
import { saveProviderKey, PROVIDER_CHOICES, type ProviderChoiceId } from "../../../lib/providerKeys.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { ICON } from "../../../lib/tokens.ts";
import { FormError, PrimaryButton, TextField } from "../../auth/controls.tsx";
import { TextLink } from "../../auth/AuthShell.tsx";
import { StepShell } from "./StepShell.tsx";

/** Where each provider's key is found. Kept here rather than in the shared list because it is a
 *  fact about a documentation site rather than about the provider's API. */
const HELP: Record<ProviderChoiceId, string> = {
  anthropic: HELP_URLS.anthropicKeys,
  openai: HELP_URLS.openaiKeys,
  google: HELP_URLS.googleKeys,
};

export function ProviderStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const [provider, setProvider] = useState<ProviderChoiceId>("anthropic");
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "valid">("idle");
  const [error, setError] = useState<string | null>(null);

  const chosen = PROVIDER_CHOICES.find((p) => p.id === provider)!;

  const save = async (): Promise<void> => {
    if (state === "checking" || key.trim().length === 0) return;
    setState("checking");
    setError(null);
    try {
      await saveProviderKey(provider, key.trim());
      setState("valid");
      // A beat on the checkmark before moving, so the one piece of feedback this screen gives is
      // seen rather than replaced by the next screen in the same frame.
      setTimeout(advance, 450);
    } catch (err) {
      // VERBATIM-BUT-SANITISED, which is the Secrets tab's own rule: a provider's own words are the
      // only thing that can distinguish "this key is revoked" from "this key is for the wrong
      // organisation", and neither is something this client could work out.
      setError((err as Error).message);
      setState("idle");
    }
  };

  return (
    <StepShell
      step={3}
      title="Connect a model provider"
      subtitle="Jaroku uses your own API key to run models. Your key stays on your device."
      skip={{ label: "Skip for now", onSkip: advance }}
      width="wide"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-5"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Model provider</legend>
          {PROVIDER_CHOICES.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer items-center gap-3 rounded-control border px-3.5 py-3 transition-colors
                duration-fast ${provider === p.id ? "border-chrome bg-active" : "border-edge bg-void hover:border-chrome"}`}
            >
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={provider === p.id}
                onChange={() => {
                  setProvider(p.id);
                  // The key belongs to the provider it was typed for. Carrying it across would send
                  // an Anthropic key to OpenAI's models-list, which fails with a message about
                  // entirely the wrong thing.
                  setKey("");
                  setState("idle");
                  setError(null);
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border
                  transition-colors duration-fast peer-focus-visible:shadow-focusring
                  ${provider === p.id ? "border-ink" : "border-edge"}`}
              >
                {provider === p.id && <span className="h-[7px] w-[7px] rounded-full bg-ink" />}
              </span>
              <span className="text-[13px] text-ink">
                {p.label}
                {p.recommended && <span className="text-muted"> (recommended)</span>}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] leading-[1.5] text-ink">API key</p>
          <TextField
            // `password`, so a key is not readable over somebody's shoulder or in a screen share —
            // which is how onboarding screenshots leak credentials.
            type="password"
            value={key}
            onChange={(v) => {
              setKey(v);
              setState("idle");
              setError(null);
            }}
            placeholder={chosen.placeholder}
            ariaLabel={`${chosen.label} API key`}
            autoFocus
            disabled={state === "checking"}
            invalid={error !== null}
          />
          <p className="text-[12px] leading-[1.5] text-muted">
            <TextLink onClick={() => void openExternal(HELP[provider])}>Where do I find this?</TextLink>
          </p>
        </div>

        {state === "valid" && (
          <p className="flex items-center gap-2 text-[12px] text-ok" role="status">
            <svg
              width={ICON.xs}
              height={ICON.xs}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Validated
          </p>
        )}
        {error && <FormError>{error}</FormError>}

        <PrimaryButton type="submit" disabled={state === "checking" || key.trim().length === 0}>
          {state === "checking" ? "Checking your key…" : state === "valid" ? "Validated" : "Continue"}
        </PrimaryButton>
      </form>
    </StepShell>
  );
}

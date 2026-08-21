// §5.1 step 3 — connect a model provider, or don't.
//
// "SKIP IS GENUINELY FIRST-CLASS HERE." The specification says it in bold and then says why: "A
// user who skips can still use the offline dry-run mode for their first agent, and can add a key
// later from the Secrets tab. The sample agent generated in Step 4 respects this." That sentence is
// the difference between this product and every other one that asks for an API key before it has
// shown you anything — and it is why the skip below is not apologetic, and why it is the one
// control on this screen that is always available whatever state the vault is in.
//
// THIS STEP GOES THROUGH THE SECRETS TAB'S OWN GATE, WHICH IS THE HARD PART.
//
// §5.1 says this step "is effectively pre-populating the Secrets tab's Model Providers group", and
// that turns out to have a consequence the specification does not mention: writing a credential in
// this product needs an UNLOCKED vault. `POST /v1/secrets` is `guarded(..., { elevation: "mutate" })`
// and refuses without a live elevation token, which is backed by a passcode.
//
// THERE WERE THREE WAYS THROUGH THAT AND ONLY ONE OF THEM IS HONEST:
//
//   1. A special unelevated write path for onboarding. Rejected: that is a hole in the exact gate
//      the Secrets tab exists to be, reachable by anybody who can hit an endpoint, and it would be
//      permanent — nothing about it would stop working once onboarding was over.
//   2. Pretend the key was stored and write it later. Rejected outright: a "✓ Validated" over a
//      credential that is not saved is the worst possible version of this screen.
//   3. Show the real gate, inline, with the skip beside it. Which is what this does.
//
// SO A LOCKED VAULT MAKES THIS SCREEN TWO THINGS IN SEQUENCE — set or unlock, then paste — and the
// copy says which is happening. That is more friction than §5.1 drew, and the honest accounting is
// that the friction is REAL rather than introduced here: the same wall stands in front of the
// Secrets tab on day two, and a person who skips this step meets it exactly once, later, when they
// have a reason to care. What this screen must not do is hide it and fail at the last moment.
//
// AND §5.3'S RESUME IS WHY IT READS EXISTING STATE FIRST. "Data already saved (workspace, provider
// key) is not re-collected — it's re-shown for confirmation only if the user navigates back to that
// step." So a provider that already has a key reads as connected, and the step becomes "confirm or
// change" rather than "create" — which is also exactly what §5.4's restart-from-settings needs.

import { useEffect, useState } from "react";
import { HELP_URLS, openExternal } from "../../../lib/openExternal.ts";
import {
  PROVIDER_CHOICES,
  connectedProviders,
  saveProviderKey,
  type ProviderChoiceId,
} from "../../../lib/providerKeys.ts";
import { fetchElevation, hasElevationToken } from "../../../lib/secrets.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { useSecretsStore } from "../../../store/secretsStore.ts";
import { ICON } from "../../../lib/tokens.ts";
import { FormError, PrimaryButton, TextField } from "../../auth/controls.tsx";
import { TextLink } from "../../auth/AuthShell.tsx";
import { SecretsGate } from "../../SecretsGate.tsx";
import { StepShell } from "./StepShell.tsx";

/** Where each provider's key is found. A fact about a documentation site, not about the API. */
const HELP: Record<ProviderChoiceId, string> = {
  anthropic: HELP_URLS.anthropicKeys,
  openai: HELP_URLS.openaiKeys,
  google: HELP_URLS.googleKeys,
};

export function ProviderStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const elevated = useSecretsStore((s) => s.elevated);

  const [provider, setProvider] = useState<ProviderChoiceId>("anthropic");
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "valid">("idle");
  const [error, setError] = useState<string | null>(null);
  /** Which providers already have a key. §5.3's "re-shown for confirmation". */
  const [connected, setConnected] = useState<Set<ProviderChoiceId>>(new Set());
  const [reading, setReading] = useState(true);

  const chosen = PROVIDER_CHOICES.find((p) => p.id === provider)!;

  // WHAT IS ALREADY TRUE, ASKED ONCE. Two questions in one pass: is this session allowed to write a
  // credential, and does one already exist. Both have to be answered before the screen can decide
  // what it is — and asking them separately would mean two renders where the screen changed shape
  // under somebody's hands.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await fetchElevation();
        const already = await connectedProviders();
        if (!live) return;
        setConnected(already);
        // Land on a provider that is NOT yet connected, so the default choice is the useful one.
        // Somebody resuming with Anthropic already set should see OpenAI selected rather than a
        // screen that looks like it is about to overwrite the key they came back to confirm.
        const next = PROVIDER_CHOICES.find((p) => !already.has(p.id));
        if (next && already.size > 0) setProvider(next.id);
      } catch {
        // A read that failed tells us nothing, and nothing is a perfectly good starting state:
        // the screen renders as if the vault is empty and the write will say otherwise if it is not.
      } finally {
        if (live) setReading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    if (state === "checking" || key.trim().length === 0) return;
    setState("checking");
    setError(null);
    try {
      await saveProviderKey(provider, key.trim());
      setState("valid");
      setConnected((s) => new Set(s).add(provider));
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

  const skip = { label: "Skip for now", onSkip: advance };

  // THE VAULT IS LOCKED. See the header: the real gate, inline, with the skip beside it. `elevated`
  // and `hasElevationToken()` are both consulted because they answer at different moments — the
  // store is filled by `fetchElevation` above, and the token is what a write will actually present.
  if (!reading && !elevated && !hasElevationToken()) {
    return (
      <StepShell
        step={3}
        title="Connect a model provider"
        subtitle="Jaroku keeps your API keys behind a passcode. Set one now, or skip and do it later."
        skip={skip}
        width="wide"
      >
        {/* THE SECRETS TAB'S OWN COMPONENT, not a copy of it. Two passcode forms would be two
            places that have to agree about the paste rule, the autofocus, the generic failure
            message and the difference between setting one and unlocking one — and the one that
            drifted would be this one, because it is seen once per account. */}
        <SecretsGate onUnlocked={() => void connectedProviders().then(setConnected)} />
      </StepShell>
    );
  }

  return (
    <StepShell
      step={3}
      title="Connect a model provider"
      subtitle="Jaroku uses your own API key to run models. Your key stays on your device."
      skip={skip}
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
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-ink">
                {p.label}
                {p.recommended && <span className="text-muted">(recommended)</span>}
                {/* §5.3's "re-shown for confirmation". A provider that already has a key says so,
                    so somebody who came back to this step knows what they are looking at rather
                    than assuming an empty field means nothing was saved. */}
                {connected.has(p.id) && (
                  <span className="ml-auto flex items-center gap-1 text-[11px] text-ok">
                    <svg
                      width={ICON.badge}
                      height={ICON.badge}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Connected
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] leading-[1.5] text-ink">
            {connected.has(provider) ? `Replace your ${chosen.label} key` : "API key"}
          </p>
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

        <PrimaryButton
          type="submit"
          // ALREADY CONNECTED AND NOTHING TYPED IS A CONTINUE, NOT A DEAD BUTTON. §5.3: a key that
          // is already saved is "re-shown for confirmation", and confirming it is pressing the
          // button — which must not require re-pasting a credential they already gave us.
          onClick={connected.has(provider) && key.trim().length === 0 ? advance : undefined}
          disabled={state === "checking" || (key.trim().length === 0 && !connected.has(provider))}
        >
          {state === "checking" ? "Checking your key…" : state === "valid" ? "Validated" : "Continue"}
        </PrimaryButton>
      </form>
    </StepShell>
  );
}

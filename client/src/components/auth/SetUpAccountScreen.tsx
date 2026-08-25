// §3.4 — the one screen between verifying an email address and using the product.
//
// "ONLY THIS." The specification says it in two words and then explains why, and the explanation is
// the design: "No company, no role, no use case, no phone number, no password. Every one of those
// fields would add 5-10% drop-off (established SaaS metric) with no operational value."
//
// So there is one field and one checkbox, and the checkbox is the only optional thing anywhere in
// this flow. Everything anybody would want to know about a new user — what they build, how big
// their team is, what they were using before — is knowable later from what they actually do, and
// asking now costs a proportion of the people who would have told you by using the product.
//
// GOOGLE USERS NEVER SEE THIS. Their `name` claim populates `display_name` at provisioning and
// their marketing opt-in defaults to false, so they go straight to account onboarding. This screen
// exists for the magic-link path, where the only thing we know about somebody is an address.
//
// THE CHECKBOX IS UNCHECKED, AND THAT IS NOT A DETAIL. Opt-in rather than opt-out: CAN-SPAM
// compliant, GDPR compliant, and — the reason that actually matters — a pre-checked box is consent
// somebody did not give, which makes every message sent on the strength of it a message they will
// mark as spam. §8 is a whole section about why that is expensive.

import { useState } from "react";
import { updateProfile } from "../../lib/profile.ts";
import { SignInFailure } from "../../lib/signIn.ts";
import { useSessionStore } from "../../store/sessionStore.ts";
import { AuthShell } from "./AuthShell.tsx";
import { Checkbox, FormError, PrimaryButton, TextField } from "./controls.tsx";

/** §3.4: "Name is 1-100 chars, trimmed, non-empty." The server holds the same number. */
const NAME_MAX = 100;

export function SetUpAccountScreen() {
  const [name, setName] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const user = await updateProfile({ name: trimmed, marketingEmailsOptIn: optIn });
      // THE STORE IS UPDATED FROM THE SERVER'S ANSWER, not from what was typed. The server trims,
      // bounds and may refuse — so believing the local value would mean the app rendering a name
      // one character longer than the one that was actually saved, which is the sort of difference
      // nobody notices until somebody's name is truncated everywhere except here.
      useSessionStore.getState().setUser(user);
      // No navigation. The gate that shows this screen reads `displayName`, and the name is no
      // longer null — so the next render is account onboarding. A screen that navigated as well
      // would be a second answer to the question the gate already answers.
    } catch (err) {
      setError(err instanceof SignInFailure ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Set up your account">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          {/* THE QUESTION IS THE LABEL. Every field on these screens is preceded by a question in
              prose, and a `<label>` repeating it two lines lower would be furniture — so the field
              carries an `aria-label` instead and the question is what everybody reads. */}
          <p className="text-label leading-[1.5] text-ink">What should we call you?</p>
          <TextField
            value={name}
            onChange={setName}
            placeholder="Your name"
            ariaLabel="Your name"
            autoFocus
            disabled={busy}
            maxLength={NAME_MAX}
            invalid={error !== null}
            name="name"
          />
          <p className="text-caption leading-[1.5] text-muted">
            Displayed in your workspace and on things you share with teammates.
          </p>
        </div>

        <Checkbox
          checked={optIn}
          onChange={setOptIn}
          label="Send me product updates"
          hint="Occasional emails about new features. No spam. Unsubscribe anytime."
        />

        {error && <FormError>{error}</FormError>}

        <PrimaryButton type="submit" disabled={busy || trimmed.length === 0}>
          {busy ? "Saving…" : "Continue"}
        </PrimaryButton>
      </form>
    </AuthShell>
  );
}

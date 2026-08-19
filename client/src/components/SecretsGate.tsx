// The lock screen, and the first-run setup that has to come before it can exist.
//
// THE EXPLANATORY LINE IS LOAD BEARING, not decoration. A user who believes the passcode ENCRYPTS
// their secrets makes worse decisions than one who knows it gates a view: they pick something
// unmemorable because they think losing it loses the data, and they are surprised when a scheduled
// run keeps working while they are asleep. It says what it does.
//
// PASTE IS ALLOWED. Blocking it is theatre that fights password managers and pushes people toward
// shorter, memorable passcodes — the opposite of the thing it is trying to achieve. So:
// `type="password"`, `autocomplete="current-password"`, a real `<label>`, autofocus, Enter submits,
// and nothing anywhere that intercepts a paste.
//
// FAILURES ARE GENERIC AND COME FROM THE SERVER. This component never composes its own "no
// passcode set" message, because the server deliberately cannot tell the difference in its
// response and inventing one here would hand back the oracle the server spent effort closing.

import { useEffect, useRef, useState } from "react";

import { EmptyState } from "./EmptyState.tsx";
import { LockIcon, ShieldCheckIcon } from "./panelIcons.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { ICON } from "../lib/tokens.ts";
import { failureCode, resetPasscode, setPasscode, unlock } from "../lib/secrets.ts";
import { useSecretsStore } from "../store/secretsStore.ts";

/** Shared field, so the unlock and setup forms cannot drift on the rules that matter. */
function PasscodeField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      {/* A real label, associated by id — not a placeholder, which disappears exactly when
          somebody with a screen reader needs it and is invisible to one that reads the field. */}
      <label htmlFor={props.id} className="block text-[11px] text-muted">
        {props.label}
      </label>
      <input
        id={props.id}
        type="password"
        autoComplete={props.autoComplete}
        // No onPaste handler, deliberately and permanently. See the header.
        spellCheck={false}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        // A BORDER, BECAUSE THE FIELD WAS INVISIBLE UNTIL IT WAS FOCUSED. `bg-bg` on a `bg-bg`
        // surface is the same colour, and the only thing that drew the box was the focus ring —
        // so the Confirm label on the passcode gate appeared with nothing beneath it, on the one
        // screen that stands between somebody and their credentials.
        className="w-full rounded-control border border-hair bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint focus:border-transparent focus:shadow-focusring disabled:opacity-40"
      />
    </div>
  );
}

/**
 * Whatever the user has to do before the tab can show anything.
 *
 * One component for both states because they are the same moment from the user's side — "I cannot
 * see my credentials yet" — and splitting them would mean two places that have to agree about the
 * paste rule, the autofocus and the error region.
 */
export function SecretsGate({ onUnlocked }: { onUnlocked: () => void }) {
  const passcodeSet = useSecretsStore((s) => s.passcodeSet);
  const pending = useSecretsStore((s) => s.pending);
  const [passcode, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // RECOVERY IS A THIRD MODE, not a sentence. "Forgot passcode?" used to set an error string
  // telling somebody to sign out and back in — which does nothing on its own: the passcode they
  // have forgotten is still the passcode, `POST /secrets/passcode` refuses a second one with a
  // 409, and there was no form anywhere that called the reset route the server has always had. A
  // forgotten passcode locked somebody out of their own credentials permanently.
  const [resetting, setResetting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Two fields, whenever a NEW passcode is being chosen — first-run setup and recovery are the
  // same form and the same rules, which is why they are one branch rather than two components
  // that could disagree about the confirm field.
  const choosingNew = !passcodeSet || resetting;

  // Clearing the field when the mode flips, so a passcode typed into the setup form is not still
  // sitting there when it becomes an unlock form.
  useEffect(() => {
    setValue("");
    setConfirm("");
    setError(null);
  }, [passcodeSet, resetting]);

  const submit = async (e?: React.FormEvent): Promise<void> => {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (!choosingNew) {
        await unlock(passcode);
      } else {
        if (passcode !== confirm) {
          setError("Those do not match");
          return;
        }
        // Reset and first-run are different routes for the same reason they look alike: one
        // refuses when a passcode already exists and the other exists precisely because one does.
        // Both need a fresh sign-in, which is what stops a stolen session installing its own gate.
        if (resetting) await resetPasscode(passcode);
        else await setPasscode(passcode);
        await unlock(passcode);
      }
      setValue("");
      setConfirm("");
      setResetting(false);
      onUnlocked();
    } catch (err) {
      const message = (err as Error).message;
      // The one case worth translating, because the server's answer is correct and unhelpful: a
      // step-up is needed and the user has no idea what that means.
      setError(
        failureCode(err) === "step_up_required"
          ? resetting
            ? "Sign out and back in first, then choose a new passcode here — a reset needs a fresh sign-in, not the old passcode."
            : "Sign in again to set a secrets passcode — this cannot be done from an existing session."
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[320px] space-y-3">
        <EmptyState
          title={resetting ? "Choose a new passcode" : passcodeSet ? "Secrets are locked" : "Set a secrets passcode"}
          hint={
            resetting ? (
              <>Sign out and back in first — a reset proves who you are to your identity provider, not with the passcode you have lost.</>
            ) : passcodeSet ? (
              pending ? (
                // WHY THEY ARE LOOKING AT THIS. An expiry mid-form is confusing enough without
                // the screen refusing to say what it interrupted.
                <>Unlock to finish: {pending.label}</>
              ) : (
                <>Asked for whenever you open Secrets.</>
              )
            ) : (
              // The line the brief calls deliberate. It is the difference between a user who
              // picks a passcode they can retype and one who thinks losing it loses the data.
              <>Asked for whenever you open Secrets. It protects this view — it does not encrypt your secrets.</>
            )
          }
          icon={choosingNew ? ShieldCheckIcon : LockIcon}
          size="inline"
        />

        <PasscodeField
          id="secrets-passcode"
          label={choosingNew ? "New passcode" : "Passcode"}
          value={passcode}
          onChange={setValue}
          autoComplete={choosingNew ? "new-password" : "current-password"}
          autoFocus
          disabled={busy}
        />
        {choosingNew ? (
          <PasscodeField
            id="secrets-passcode-confirm"
            label="Confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            disabled={busy}
          />
        ) : null}

        {/* POLITE, not assertive: an error here interrupts nothing, and `assertive` would talk
            over somebody still typing. One region, so a second failure replaces the first rather
            than queueing behind it. */}
        <p
          ref={errorRef}
          aria-live="polite"
          role="status"
          className={`min-h-[16px] text-[11px] ${error ? "text-err" : "text-faint"}`}
        >
          {error ?? ""}
        </p>

        <div className="flex items-center gap-2">
          <button type="submit" className={primaryBtn} disabled={busy || !passcode}>
            {busy ? "Working…" : choosingNew ? "Verify identity & save" : "Unlock"}
          </button>
          {passcodeSet ? (
            // Recovery is a full re-authentication, never an email link — the whole point of
            // elevation is proving the person is still there, and a link in a mailbox proves
            // somebody had the mailbox. So this opens the form rather than describing one: the
            // reset route needs a fresh sign-in, and the refusal it gives says so in words.
            <button type="button" className={quietBtn} onClick={() => setResetting(!resetting)}>
              {resetting ? "Back to unlock" : "Forgot passcode?"}
            </button>
          ) : null}
        </div>

        <p className="text-[11px] text-faint">
          <LockIcon size={ICON.xs} />{" "}
          {choosingNew
            ? "Six to twelve characters, and it is per person, not per workspace."
            : "Six to twelve characters. Paste is fine — use a password manager."}
        </p>
      </form>
    </div>
  );
}

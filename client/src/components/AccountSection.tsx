// `/settings/account` — the things that belong to a PERSON rather than to a workspace.
//
// A FIFTH SECTION IN A PANEL WHOSE OTHER FOUR ARE ABOUT A WORKSPACE, and that distinction is the
// whole reason it is separate rather than a row inside Members. Members, Audit, Billing and Data
// are all scoped by `workspace_id`; everything here is scoped by `user_id` and follows somebody to
// every workspace they are in. Putting "restart my onboarding tour" under Members would file a
// personal preference under a tenant's settings, which is the same conflation §1 of the onboarding
// specification opens by warning about.
//
// §5.4 IS THE ONE CONTROL IT HAS TODAY, and the promise it makes is the interesting part: "Your
// workspace and settings won't change." The route clears two columns — the completion flag and the
// step — and touches nothing else, so the workspace, the provider key and every agent stay exactly
// where they are. That is what makes steps 2-4 read as "confirm or change" rather than "create" the
// second time through.

import { useState } from "react";
import { useAccountOnboardingStore } from "../store/accountOnboardingStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { TYPE } from "../lib/tokens.ts";

export function AccountSection() {
  const user = useSessionStore((s) => s.user);
  const restart = useAccountOnboardingStore((s) => s.restart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restart();
      // CLOSED, because the five screens take the whole surface and a settings panel floating over
      // them would be a panel nobody can see and nobody can close. The gate in `App` does the rest:
      // the flag is false again, so the next render is step 1.
      useUiStore.getState().closeWorkspacePanel();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className={TYPE.sectionLabel}>Account</h3>
        <dl className="flex flex-col gap-1.5">
          <Row label="Signed in as" value={user?.email ?? "—"} />
          {/* NULL IS RENDERED AS A DASH RATHER THAN AS AN EMPTY ROW. §10 says an account with no
              name should not happen and describes how it self-heals if one does; showing the gap
              is what makes that state visible rather than a row that looks like a rendering bug. */}
          <Row label="Name" value={user?.displayName ?? "—"} />
        </dl>
      </section>

      <section className="flex flex-col gap-2 border-t border-hair pt-5">
        <h3 className={TYPE.sectionLabel}>Onboarding</h3>
        <p className="text-[13px] leading-[1.5] text-ink">Restart onboarding tour</p>
        <p className="text-[12px] leading-[1.6] text-muted">
          Walk through the setup screens again. Your workspace, keys and agents won&rsquo;t change
          &mdash; only the tour resets.
        </p>
        {error && (
          <p role="alert" className="text-[12px] leading-[1.5] text-err">
            {error}
          </p>
        )}
        <div className="mt-1 flex">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="rounded-control border border-edge px-3 py-1.5 text-[12px] text-ink outline-none
              transition-colors duration-fast hover:border-chrome focus-visible:shadow-focusring
              disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Restarting…" : "Restart"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[110px] shrink-0 text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-[13px] text-ink">{value}</dd>
    </div>
  );
}

// §5.1 step 2 — the only step in the flow that is not optional, and the reason it still has a skip.
//
// "SKIP USES THE PRE-FILLED VALUE SILENTLY — a workspace must exist for the user to do anything, so
// this step cannot truly be skipped in terms of workspace creation; skip just means 'accept the
// default and move on'." Which is why the skip here does exactly what Continue does, with whatever
// is in the box. A skip that refused to create one would leave somebody in an app with no workspace,
// and every panel in it is a view of one workspace's data.
//
// AND IT DOES NOT CREATE A SECOND ONE. `provisionUser` already made a personal workspace at sign-up
// — that is what `defaultWorkspaceId` names — so what this step does is RENAME it. §5.1's own text
// says "POST /v1/workspaces … creates the workspace", which is right for a specification written
// against a system where signing in does not, and wrong here: following it literally would leave
// every new account with two workspaces, one of them empty and named after their email address.
//
// §5.3'S RESUME IS WHY `workspaceNamed` EXISTS. "Steps already completed are not re-done. Workspace
// already created → step 2 is skipped on resume." Somebody resuming past this step has named one,
// and re-asking would be asking them to name a thing that already has the name they gave it.

import { useState } from "react";
import { renameWorkspace } from "../../../lib/workspaceApi.ts";
import { defaultWorkspaceName, WORKSPACE_NAME_MAX } from "../../../lib/accountOnboarding.ts";
import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { useSessionStore } from "../../../store/sessionStore.ts";
import { FormError, PrimaryButton, TextField } from "../../auth/controls.tsx";
import { StepShell } from "./StepShell.tsx";

export function WorkspaceStep({ firstName }: { firstName: string | null }) {
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const advance = useAccountOnboardingStore((s) => s.advance);
  const markNamed = useAccountOnboardingStore((s) => s.markWorkspaceNamed);

  // The workspace this is about: the one this session is acting in, or the first one there is.
  // Never a new one — see the header.
  const target = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;

  // PRE-FILLED, AND FROM THE PERSON'S NAME RATHER THAN THE WORKSPACE'S CURRENT ONE. The current one
  // is derived from their email address at sign-up ("ada@example.com"), which is exactly the value
  // this step exists to replace — offering it back as the default would make accepting the default
  // the wrong choice.
  const [name, setName] = useState(() => defaultWorkspaceName(firstName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const save = async (): Promise<void> => {
    if (busy) return;
    // A skip with an emptied box uses the default rather than refusing, which is the whole of
    // "skip just means accept the default and move on".
    const chosen = trimmed || defaultWorkspaceName(firstName);
    setBusy(true);
    setError(null);
    try {
      if (target && chosen !== target.name) {
        const updated = await renameWorkspace(target.id, chosen);
        useSessionStore
          .getState()
          .setWorkspaces(workspaces.map((w) => (w.id === updated.id ? { ...w, name: updated.name } : w)));
      }
      markNamed();
      advance();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <StepShell
      step={2}
      title="Name your workspace"
      subtitle="You can rename it later."
      skip={{ label: "Skip for now", onSkip: () => void save() }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          value={name}
          onChange={setName}
          ariaLabel="Workspace name"
          placeholder={defaultWorkspaceName(firstName)}
          autoFocus
          disabled={busy}
          maxLength={WORKSPACE_NAME_MAX}
          invalid={error !== null}
        />
        {error && <FormError>{error}</FormError>}
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Saving…" : "Continue"}
        </PrimaryButton>
      </form>
    </StepShell>
  );
}

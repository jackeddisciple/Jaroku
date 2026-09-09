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
import { updateProfile } from "../lib/profile.ts";
import { SignInFailure } from "../lib/signIn.ts";
import { TextField } from "./auth/controls.tsx";
import { secondaryBtn } from "./buttons.ts";
import { AvatarEditor } from "./AvatarEditor.tsx";
import { loadAvatar, removeAvatar, uploadAvatar } from "../lib/avatar.ts";
import { useEffect, useRef } from "react";
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
          <UsernameRow />
          <PictureRow />
        </dl>
      </section>

      <section className="flex flex-col gap-2 border-t border-hair pt-5">
        <h3 className={TYPE.sectionLabel}>Onboarding</h3>
        <p className="text-label leading-[1.5] text-ink">Restart onboarding tour</p>
        <p className="text-caption leading-[1.6] text-muted">
          Walk through the setup screens again. Your workspace, keys and agents won&rsquo;t change
          &mdash; only the tour resets.
        </p>
        {error && (
          <p role="alert" className="text-caption leading-[1.5] text-err">
            {error}
          </p>
        )}
        <div className="mt-1 flex">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="rounded-control border border-edge px-3 py-1.5 text-caption text-ink outline-none
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

/**
 * The one field on this surface somebody can CHANGE, which is why it is a component and not a `Row`.
 *
 * IT EDITS IN PLACE RATHER THAN OPENING A DIALOG. A username is a single short string with no
 * confirmation worth asking for and nothing that breaks when it changes — a modal for it would be
 * more ceremony than the change deserves. The row reads as the others until you press Change.
 *
 * EMPTY IS A VALID ANSWER AND SAVES AS "NONE". The server treats `""` as a clear rather than a
 * refusal (see `profileHandler`), which is what lets somebody undo a username without a second
 * control to do it with — and the footer falls straight back to their name.
 */
function UsernameRow() {
  const user = useSessionStore((s) => s.user);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfile({ username: value.trim() });
      useSessionStore.getState().setUser(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof SignInFailure ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-baseline gap-3">
        <dt className="w-[110px] shrink-0 text-caption text-muted">Username</dt>
        <dd className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 break-all text-label text-ink">{user?.username ?? "—"}</span>
          <button
            type="button"
            onClick={() => { setValue(user?.username ?? ""); setError(null); setEditing(true); }}
            className="shrink-0 text-caption text-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            Change
          </button>
        </dd>
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[110px] shrink-0 text-caption text-muted">Username</dt>
      <dd className="flex min-w-0 flex-1 flex-col gap-2">
        <TextField
          value={value}
          onChange={setValue}
          placeholder="Anything you like"
          ariaLabel="Your username"
          autoFocus
          disabled={busy}
          maxLength={USERNAME_MAX}
          invalid={error !== null}
          name="username"
        />
        {error && <p className="text-caption text-err">{error}</p>}
        <p className="text-caption leading-[1.5] text-muted">
          Shown at the bottom of your sidebar. Leave it empty to go back to your name.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => void save()} disabled={busy} className={secondaryBtn}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            className="text-caption text-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            Cancel
          </button>
        </div>
      </dd>
    </div>
  );
}

/** Mirrors `USERNAME_MAX` in the server's `auth/session.ts`. */
const USERNAME_MAX = 30;

/**
 * The picture: what it is now, and the two things that can be done about it.
 *
 * THE FILE INPUT IS HIDDEN BEHIND A BUTTON, which is the ordinary way to do this and worth a line
 * because the alternative looks simpler and is not: a bare `<input type="file">` cannot be styled
 * to match anything, differs on every platform, and says "Choose File / no file selected" in the
 * middle of a settings panel.
 *
 * PICKING A FILE OPENS THE EDITOR RATHER THAN UPLOADING. Nobody's photo is already a square, so an
 * upload with no crop step is an upload that centre-crops somebody's face by accident.
 */
function PictureRow() {
  const user = useSessionStore((s) => s.user);
  const hasAvatar = user?.hasAvatar ?? false;
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hasAvatar) { setUrl(null); return; }
    let live = true;
    void loadAvatar().then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [hasAvatar]);

  const saved = async (blob: Blob): Promise<void> => {
    await uploadAvatar(blob);
    setFile(null);
    // The session carries `hasAvatar`, and the footer reads it — so the store is what has to be
    // told, not this component. `loadAvatar` was invalidated by `uploadAvatar`, so the effect
    // above refetches the new bytes.
    const current = useSessionStore.getState().user;
    if (current) useSessionStore.getState().setUser({ ...current, hasAvatar: true });
    setUrl(await loadAvatar());
  };

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeAvatar();
      const current = useSessionStore.getState().user;
      if (current) useSessionStore.getState().setUser({ ...current, hasAvatar: false });
      setUrl(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (file) {
    return (
      <div className="flex items-start gap-3">
        <dt className="w-[110px] shrink-0 pt-1 text-caption text-muted">Picture</dt>
        <dd className="min-w-0 flex-1">
          <AvatarEditor file={file} onCancel={() => setFile(null)} onSave={saved} />
        </dd>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <dt className="w-[110px] shrink-0 text-caption text-muted">Picture</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-chrome text-label text-ink">
          {url
            ? <img src={url} alt="" className="h-full w-full object-cover" />
            : (user?.username || user?.displayName || user?.email || "?").trim().charAt(0).toUpperCase()}
        </span>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            setError(null);
            setFile(picked);
            // CLEARED SO THE SAME FILE CAN BE PICKED TWICE. Without this, choosing a photo,
            // cancelling, and choosing the same photo again fires no `change` event at all.
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className={secondaryBtn}>
          {hasAvatar ? "Change" : "Upload"}
        </button>
        {hasAvatar && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="text-caption text-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            Remove
          </button>
        )}
        {error && <span className="text-caption text-err">{error}</span>}
      </dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[110px] shrink-0 text-caption text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-label text-ink">{value}</dd>
    </div>
  );
}

// The Secrets tab.
//
// FIVE THINGS AUTO-LOCK IT, and they are not all events this component can see, which is why the
// state comes from the server rather than from a local timer:
//
//   the TTL expiring        the local tick notices first, the next request confirms it
//   pressing Lock now       ends it for every tab of the session, server-side
//   signing out             the session id is a digest of the bearer token, so a new token is a
//                           new session and the old elevation is unreachable — nothing here has to
//                           watch for it
//   the window hidden 2m    a `visibilitychange` timer, below
//   another device          the poll picks it up, because "am I elevated" is a server question
//
// WHY IT POLLS RATHER THAN TAKING A SOCKET CHANNEL. The brief allows either ("on next poll or via
// WS event"). A channel would need an entry in COMMAND_CHANNEL, a classification in
// `channels.test.ts`, and a broadcast path — for a fact this component already has to re-read
// every few seconds to render a countdown. The poll is the cheaper honest answer, and it is the
// same request that drives the timer.
//
// SWITCHING AWAY DOES NOT LOCK. Elevation is a property of the session, not of the view, so
// re-entering within the TTL opens straight to content. That falls out of the state living in the
// store rather than in this component.

import { useEffect, useRef, useState } from "react";

import { SecretsGate } from "./SecretsGate.tsx";
import { SecretsList } from "./SecretsList.tsx";
import { AlertTriangleIcon, ClockIcon, LockIcon, PlusIcon, XIcon } from "./panelIcons.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { ICON } from "../lib/tokens.ts";
import {
  changePasscode,
  createSecret,
  fetchElevation,
  fetchHealth,
  fetchSecrets,
  hasElevationToken,
  importSecrets,
  joinElevation,
  lockNow,
} from "../lib/secrets.ts";
import { formatRemaining, holdForElevation, isFinalMinute, useSecretsStore } from "../store/secretsStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import { useCanReach } from "../lib/useCapability.ts";

/** How often the gate state is re-read. Also the countdown's correction against the server. */
const POLL_MS = 15_000;
/** The brief's rule: a window hidden this long locks. Somebody has walked away. */
const HIDDEN_LOCK_MS = 2 * 60 * 1000;

function HealthStrip() {
  const health = useSecretsStore((s) => s.health);
  if (!health) return null;
  const items = [
    health.invalid > 0 ? `${health.invalid} not working` : null,
    health.expiringSoon > 0 ? `${health.expiringSoon} expiring within 7 days` : null,
    health.rotationDue > 0 ? `${health.rotationDue} due for rotation` : null,
    health.unusedNinetyDays > 0 ? `${health.unusedNinetyDays} unused for 90 days` : null,
  ].filter(Boolean);
  if (!items.length) return null;
  // ONE COMPACT STRIP AT THE TOP rather than a warning scattered across the rows it concerns —
  // the brief asks for this specifically, and a badge on every affected row makes the list hard to
  // read while telling somebody nothing they can act on as a whole.
  return (
    <div className="flex items-start gap-2 rounded-control border border-hair px-2 py-1.5 text-tiny text-muted">
      <AlertTriangleIcon size={ICON.xs} />
      <span className="min-w-0 flex-1">{items.join(" · ")}</span>
    </div>
  );
}

function Countdown() {
  const remainingMs = useSecretsStore((s) => s.remainingMs);
  const finalMinute = isFinalMinute(remainingMs);
  return (
    <span className="flex items-center gap-1 text-tiny">
      {/* THE ICON CHANGES IN THE LAST MINUTE, not only the colour. A countdown signalled by an
          amber tint alone is invisible to a meaningful number of people, and the brief says so. */}
      {finalMinute ? (
        <AlertTriangleIcon size={ICON.xs} />
      ) : (
        <ClockIcon size={ICON.xs} />
      )}
      <span
        // The ticking number is hidden from assistive tech: announcing it would read a new value
        // every second. The single coarse announcement is in the live region below.
        aria-hidden="true"
        className={
          finalMinute
            ? "text-run animate-stream-pulse motion-reduce:animate-none"
            : "text-muted"
        }
      >
        {formatRemaining(remainingMs)}
      </span>
    </span>
  );
}

export function SecretsPanel() {
  // `secret:manage` — the capability behind `POST /v1/secrets` and its rotate, reveal and revoke
  // siblings. See the action row below for why this is separate from the elevation gate.
  const canWrite = useCanReach("secretWrite");
  const elevated = useSecretsStore((s) => s.elevated);
  const gate = useSecretsStore((s) => s.gate);
  const gateLoaded = useSecretsStore((s) => s.gateLoaded);
  const remainingMs = useSecretsStore((s) => s.remainingMs);
  const error = useSecretsStore((s) => s.error);
  const notice = useSecretsStore((s) => s.notice);
  const pending = useSecretsStore((s) => s.pending);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [changingPasscode, setChangingPasscode] = useState(false);
  const hiddenSince = useRef<number | null>(null);

  // ARRIVING FROM A DEAD END RATHER THAN FROM THE TAB BAR. §5.2: the way out of a model with no key
  // opens this tab "with the add dialog pre-opened for that provider", and switching the tab used
  // to be the whole of it — somebody landed on a list and had to work out that Add was next, and
  // then which UPPER_SNAKE_CASE name the provider wanted. Consumed once and cleared, because it
  // describes a navigation that has happened: left set, the form would reopen on every visit.
  const addProvider = useUiStore((s) => s.secretsAddProvider);
  const clearAddProvider = useUiStore((s) => s.clearSecretsAddProvider);
  const [arrivedFor, setArrivedFor] = useState<string | null>(null);
  const arrivedForProvider = useProviderStore((s) => s.providers.find((p) => p.id === arrivedFor) ?? null);
  useEffect(() => {
    if (addProvider === null && arrivedFor === null) return;
    setAdding(true);
    setArrivedFor(addProvider);
    clearAddProvider();
    // `addProvider` only; re-running on `arrivedFor` would reopen the form the moment it is closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addProvider]);

  // Under `mutations` the metadata list is readable without elevation, so the content renders
  // while locked and only the verbs are gated. Under `tab` — the default, and what ships —
  // nothing renders.
  const canSeeContent = elevated || gate === "mutations";

  const refresh = async (): Promise<void> => {
    const store = useSecretsStore.getState();
    try {
      const state = await fetchElevation();
      store.setElevation(state);
      // A tab that has no token but whose SESSION is elevated rejoins rather than asking for the
      // passcode again — a reload, or a second tab. The token it gets inherits the original
      // expiry, so this cannot extend anything.
      if (state.elevated && !hasElevationToken()) await joinElevation();
      if (state.elevated || state.gate === "mutations") {
        store.setSecrets(await fetchSecrets());
      }
    } catch (err) {
      store.setError((err as Error).message);
    }
    // Health is fetched regardless, because it is the one answer that works while locked and it
    // drives the tab's badge whether or not this panel is even open.
    try {
      store.setHealth(await fetchHealth());
    } catch {
      /* the badge is not worth an error strip */
    }
  };

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    // One second, because a countdown that jumps in fifteen-second steps is not a countdown. This
    // only recomputes from a timestamp already held — it makes no request.
    const tick = setInterval(() => useSecretsStore.getState().tick(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  // Hidden for two minutes locks. Measured on the way back rather than by a timer that fires while
  // hidden, because background timers are throttled to the point of being unreliable — a setTimeout
  // that was supposed to fire at two minutes can arrive at ten, which would be a lock that felt
  // random rather than one that felt like a rule.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenSince.current = Date.now();
        return;
      }
      const since = hiddenSince.current;
      hiddenSince.current = null;
      if (since !== null && Date.now() - since >= HIDDEN_LOCK_MS && useSecretsStore.getState().elevated) {
        void lockNow().then(() => void refresh());
      } else {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const onUnlocked = async (): Promise<void> => {
    await refresh();
    // RESUME WHAT THE TIMER INTERRUPTED. The whole reason `pending` exists: losing a half-typed
    // credential to an expiry is a self-inflicted wound.
    const store = useSecretsStore.getState();
    const held = store.pending;
    if (held) {
      store.setPending(null);
      try {
        await held.run();
        await refresh();
      } catch (err) {
        store.setError((err as Error).message);
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-2">
        <span className="flex items-center gap-1.5 text-caption text-ink">
          <LockIcon size={ICON.sm} /> Secrets
        </span>
        <div className="flex-1" />
        {elevated ? (
          <>
            <Countdown />
            <button className={quietBtn} onClick={() => void lockNow().then(() => void refresh())}>
              Lock now
            </button>
          </>
        ) : null}
      </div>

      {/* ANNOUNCED ONCE, NOT PER SECOND. The region's text changes only when the state changes —
          unlocked, in the final minute, locked — so assistive tech says three things over ten
          minutes rather than six hundred. */}
      <p aria-live="polite" role="status" className="sr-only">
        {!gateLoaded
          ? ""
          : elevated
            ? isFinalMinute(remainingMs)
              ? "Secrets lock in under a minute."
              : "Secrets are unlocked."
            : "Secrets are locked."}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* Nothing at all until the first state lands, so the lock screen does not flash in front
            of somebody who is already elevated. */}
        {!gateLoaded ? null : !canSeeContent ? (
          <SecretsGate onUnlocked={() => void onUnlocked()} />
        ) : (
          <div className="space-y-3">
            {error ? (
              <div className="flex items-start gap-2 rounded-control border border-err/30 px-2 py-1.5 text-tiny text-err">
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button
                  className="shrink-0 text-faint hover:text-ink"
                  aria-label="Dismiss"
                  onClick={() => useSecretsStore.getState().setError(null)}
                >
                  <XIcon size={ICON.xs} />
                </button>
              </div>
            ) : null}
            {notice ? (
              <div className="flex items-start gap-2 rounded-control border border-hair px-2 py-1.5 text-tiny text-muted">
                <span className="min-w-0 flex-1 break-words">{notice}</span>
                <button
                  className="shrink-0 text-faint hover:text-ink"
                  aria-label="Dismiss"
                  onClick={() => useSecretsStore.getState().setNotice(null)}
                >
                  <XIcon size={ICON.xs} />
                </button>
              </div>
            ) : null}
            {pending ? (
              <div className="rounded-control border border-hair px-2 py-1.5 text-tiny text-muted">
                Waiting to finish: {pending.label}
              </div>
            ) : null}

            <HealthStrip />

            {/* §8.2 — "Secrets panel / Add, rotate, reveal / connector:manage". The commands here
                are not commands at all: every one of them is an HTTP route, because elevation
                rides on a request header a WebSocket cannot carry. The route's own capability is
                `secret:manage`, the admin's, which is the same rung the checklist names.

                THE ELEVATION GATE IS NOT THIS GATE, and neither replaces the other. Elevation asks
                "is it still them, right now"; a capability asks "is this person entitled to this
                class of thing at all". A member can pass the passcode and still not be entitled to
                store a credential the whole workspace runs on — which is why `secret:read` is a
                member capability and `secret:manage` is not, and why the LIST below stays.

                THE PASSCODE ROW GOES WITH THEM. It is the gate in front of the writes, and a
                control for changing the lock on a door somebody may not open is a control with
                nothing behind it. */}
            {canWrite && (
              <div className="flex items-center gap-2">
                <button className={secondaryBtn} onClick={() => setAdding((v) => !v)}>
                  <PlusIcon size={ICON.xs} /> Add
                </button>
                <button className={quietBtn} onClick={() => setImporting((v) => !v)}>
                  Import
                </button>
                {/* The only way to reach PATCH /secrets/passcode. The route and the client function
                    both existed; nothing rendered a control for either, so somebody who wanted to
                    change a passcode they still knew had to forget it first and recover. */}
                <button className={quietBtn} onClick={() => setChangingPasscode((v) => !v)}>
                  Change passcode
                </button>
              </div>
            )}

            {canWrite && adding ? (
              <AddForm
                // Keyed on the provider, so arriving for a SECOND one while the form is already
                // open remounts it with the new name rather than leaving the first one in the field.
                key={arrivedForProvider?.env_key ?? "manual"}
                // Pre-filled when the tab was reached from a model the workspace has no key for.
                // §5.2 asks for the dialog "pre-opened for that provider", and the provider's own
                // variable name is the part somebody would otherwise have to know.
                initialName={arrivedForProvider?.env_key ?? ""}
                onDone={() => { setAdding(false); void refresh(); }}
              />
            ) : null}
            {canWrite && importing ? <ImportForm onDone={() => { setImporting(false); void refresh(); }} /> : null}
            {canWrite && changingPasscode ? (
              <PasscodeForm onDone={() => { setChangingPasscode(false); void refresh(); }} />
            ) : null}

            <SecretsList onChanged={() => void refresh()} />
          </div>
        )}
      </div>
    </div>
  );
}

function AddForm({ initialName = "", onDone }: { initialName?: string; onDone: () => void }) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const setError = useSecretsStore((s) => s.setError);
  return (
    <form
      className="space-y-2 rounded-control border border-hair px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        // HELD RATHER THAN LOST when the ten minutes ran out between opening this form and
        // submitting it. The thunk closes over what was typed, so unlocking finishes the save the
        // user already asked for instead of asking them to type a credential again from memory.
        const typed = { name: name.trim().toUpperCase(), value };
        void holdForElevation(`add ${typed.name}`, async () => void (await createSecret(typed)))
          .then(() => {
            setName("");
            setValue("");
            onDone();
          })
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex items-center gap-2">
        <input
          autoFocus
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-control bg-bg px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
        />
        <input
          type="password"
          autoComplete="off"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-[2] rounded-control bg-bg px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
        />
        <button type="submit" className={primaryBtn} disabled={busy || !name || !value}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-tiny text-faint">
        UPPER_SNAKE_CASE. A provider key is validated with the provider before it is stored.
      </p>
    </form>
  );
}

/**
 * Changing a passcode somebody still knows.
 *
 * THE CURRENT ONE IS ASKED FOR AS WELL AS ELEVATION, and that is the server's rule rather than this
 * form's politeness: an unlocked tab left open would otherwise be a tab that can change the
 * passcode, which is how somebody loses their credentials to whoever walked past the desk.
 *
 * A SUCCESSFUL CHANGE ENDS EVERY ELEVATION, on every device — the proof they were all granted under
 * is the passcode that no longer exists. So this closes onto the lock screen, which is correct and
 * worth saying out loud rather than looking like a failure.
 */
function PasscodeForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const setError = useSecretsStore((s) => s.setError);
  const setNotice = useSecretsStore((s) => s.setNotice);
  const field =
    "min-w-0 flex-1 rounded-control bg-bg px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring";
  return (
    <form
      className="space-y-2 rounded-control border border-hair px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== confirm) {
          setError("Those do not match");
          return;
        }
        setBusy(true);
        setError(null);
        void changePasscode(current, next)
          .then(() => {
            setCurrent("");
            setNext("");
            setConfirm("");
            setNotice("Passcode changed. Every unlocked tab was locked, including this one.");
            onDone();
          })
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="secrets-passcode-current">Current passcode</label>
        <input
          id="secrets-passcode-current"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoFocus
          placeholder="current"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={field}
        />
        <label className="sr-only" htmlFor="secrets-passcode-next">New passcode</label>
        <input
          id="secrets-passcode-next"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder="new"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={field}
        />
        <label className="sr-only" htmlFor="secrets-passcode-again">Confirm new passcode</label>
        <input
          id="secrets-passcode-again"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder="confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={field}
        />
        <button type="submit" className={primaryBtn} disabled={busy || !current || !next}>
          {busy ? "Saving…" : "Change"}
        </button>
      </div>
      <p className="text-tiny text-faint">
        Six to twelve characters. Changing it locks Secrets everywhere you are signed in.
      </p>
    </form>
  );
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const setError = useSecretsStore((s) => s.setError);
  const setNotice = useSecretsStore((s) => s.setNotice);
  return (
    <form
      className="space-y-2 rounded-control border border-hair px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const pasted = text;
        void holdForElevation("finish the import", async () => {
          const result = await importSecrets(pasted);
          const rejected = result.rejected.length ? `, ${result.rejected.length} skipped` : "";
          setNotice(`Imported ${result.imported.length} from a ${result.format} export${rejected}.`);
        })
          .then(() => {
            setText("");
            onDone();
          })
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <textarea
        autoFocus
        rows={4}
        placeholder={"Paste a .env, or a 1Password / Vault / Doppler export"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-control bg-bg px-2.5 py-1.5 font-mono text-tiny text-ink outline-none placeholder:text-faint focus:shadow-focusring"
      />
      <div className="flex items-center gap-2">
        <button type="submit" className={primaryBtn} disabled={busy || !text.trim()}>
          {busy ? "Importing…" : "Import"}
        </button>
        <span className="text-tiny text-faint">Values are stored, never echoed back.</span>
      </div>
    </form>
  );
}

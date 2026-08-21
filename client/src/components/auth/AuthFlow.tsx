// Which of the sign-in screens is showing, and what moves between them.
//
// A STATE MACHINE IN ONE PLACE, because the alternative is four screens each deciding when the next
// one appears. §3 and §4 describe one flow with several exits — a browser hop that may never come
// back, a link that may be clicked on another device, a ticket that may already be spent, a new
// account that still has to say its name — and the thing they have in common is that NONE of them is
// a decision the screen showing at the time can make.
//
// THE DEEP LINK IS CLAIMED HERE AND NOWHERE ELSE. `onAuthCallback` hands readiness to exactly one
// consumer at a time (see lib/authLink.ts), and this is it: while this component is mounted, a
// `jaroku://auth/complete` is a ticket to exchange, and while it is not, one is queued. That is the
// whole of §4.5's "queue it — complete first-run, then process on transition to sign-in", and it is
// why the claim is an effect rather than a subscription in `main.tsx`.
//
// WHAT IS DELIBERATELY NOT HERE: anything about a workspace. Every screen this renders is a screen
// somebody sees with no session, so there is no workspace to scope, nothing to reset, and no socket
// to keep alive. The moment there is one, this component stops being rendered.

import { useCallback, useEffect, useRef, useState } from "react";
import { storeWorkspace } from "../../lib/auth.ts";
import { clearAuthCallback, onAuthCallback } from "../../lib/authLink.ts";
import { SignInFailure, clearNonce, exchangeTicket } from "../../lib/signIn.ts";
import { restartSocket } from "../../lib/socket.ts";
import { useSessionStore } from "../../store/sessionStore.ts";
import { AuthNotice } from "./AuthShell.tsx";
import { PrimaryButton } from "./controls.tsx";
import { CheckEmailScreen } from "./CheckEmailScreen.tsx";
import { SignInScreen } from "./SignInScreen.tsx";
import { Reveal } from "../onboarding/Reveal.tsx";

/**
 * The screens, and the one rule that orders them.
 *
 * `exchanging` IS A STATE RATHER THAN A SPINNER ON THE PREVIOUS SCREEN, and that is not cosmetic.
 * The ticket exchange happens when the operating system wakes this window, which may be seconds or
 * minutes after somebody left — so the screen they come back to has to be about what is happening
 * NOW, not about the button they last pressed. A sign-in screen with a quiet spinner on it reads as
 * a sign-in that has not started.
 */
type Screen =
  | { at: "signin" }
  /** §3.3 step 4. Owns the address, because the resend and the "wrong email" both need it. */
  | { at: "sent"; email: string; expiresInMinutes: number }
  | { at: "exchanging" }
  /** §4.5's first three rows, which all say the same sentence for the same reason. */
  | { at: "expired" };

export function AuthFlow() {
  const [screen, setScreen] = useState<Screen>({ at: "signin" });
  // EXACTLY ONCE PER TICKET, across the re-renders the exchange itself causes. A ticket is
  // single-use, so a second attempt is guaranteed to fail — and it would fail with "that link
  // expired", which is a message somebody would see for a sign-in that actually worked.
  const spending = useRef(false);

  const spend = useCallback(async (ticket: string): Promise<void> => {
    if (spending.current) return;
    spending.current = true;
    setScreen({ at: "exchanging" });
    try {
      const session = await exchangeTicket(ticket);
      // The workspace this account should land in, remembered before the socket opens so the
      // ticket request that follows asks for the right one rather than the previous account's.
      storeWorkspace(session.defaultWorkspaceId);
      // A token exists now. Restarting the socket runs the whole exchange — session, ws-ticket,
      // connect — and moves the session store to `ready` when it lands. From here on this component
      // is unmounted and everything below it is the app.
      useSessionStore.getState().setStatus("connecting");
      restartSocket();
    } catch (err) {
      clearNonce();
      // §4.5: expired, already used, and forged all produce ONE message. The distinction lives in
      // the server's audit log, because a used-ticket message a person can tell apart from an
      // invalid-ticket message is a fingerprinting signal for whether an account exists.
      if (err instanceof SignInFailure && err.kind === "expired") setScreen({ at: "expired" });
      else {
        setScreen({ at: "signin" });
        useSessionStore
          .getState()
          .setStatus("signed_out", err instanceof Error ? err.message : "that sign-in did not complete");
      }
    } finally {
      spending.current = false;
    }
  }, []);

  // CLAIMED FOR AS LONG AS THIS IS MOUNTED. Anything held from before — a link that started the
  // application while first-run was still going — is delivered synchronously the moment this runs,
  // which is the first frame on which a ticket could possibly have been spent.
  useEffect(() => onAuthCallback((callback) => void spend(callback.ticket)), [spend]);

  if (screen.at === "exchanging") {
    return (
      <AuthNotice>
        <Reveal>
          <h1 className="font-serif text-[32px] font-normal leading-[1.15] text-ink">Signing you in</h1>
        </Reveal>
        <Reveal delay={60}>
          <p className="mx-auto mt-3 max-w-[34ch] font-serif text-[15px] leading-[1.5] text-muted">
            One moment — finishing up.
          </p>
        </Reveal>
      </AuthNotice>
    );
  }

  if (screen.at === "expired") {
    return (
      <AuthNotice>
        <h1 className="font-serif text-[32px] font-normal leading-[1.15] text-ink">That link expired</h1>
        <p className="mx-auto mt-3 max-w-[38ch] text-[13px] leading-[1.6] text-muted">
          Sign-in links are good for a minute and can only be used once. Starting again takes a
          couple of seconds.
        </p>
        <div className="mx-auto mt-8 max-w-[300px]">
          <PrimaryButton onClick={() => setScreen({ at: "signin" })} autoFocus>
            Back to sign in
          </PrimaryButton>
        </div>
      </AuthNotice>
    );
  }

  if (screen.at === "sent") {
    return (
      <CheckEmailScreen
        email={screen.email}
        expiresInMinutes={screen.expiresInMinutes}
        // §3.3: "No 'resend to a different email' option. If the user typed the wrong address, they
        // use 'Start over' — resending to a different address on the same session is a phishing
        // surface." So the way back is the whole way back, to a screen with an empty field on it.
        onStartOver={() => setScreen({ at: "signin" })}
      />
    );
  }

  return (
    <SignInScreen
      // REACHED ONLY AFTER THE SERVER ACCEPTED THE REQUEST. The sign-in screen sends it and hands
      // up the answer, so this screen is never shown for a message nothing dispatched — which is
      // the one failure mode §8 spends a whole section preventing, and the reason `onSent` carries
      // the expiry rather than this component assuming fifteen minutes.
      onSent={(email, expiresInMinutes) => setScreen({ at: "sent", email, expiresInMinutes })}
    />
  );
}

/**
 * §4.5's last row: "Deep-link arrives while a different user is signed in → Prompt: 'Sign in as
 * [new user email]? This will sign out [current user].' with explicit Cancel and Continue. Never
 * silent user swap."
 *
 * MOUNTED BESIDE THE APP RATHER THAN INSTEAD OF IT, which is the whole difference between this and
 * everything above. Somebody is signed in and working; a link arrived. Taking the screen away from
 * them to ask would be the modal-mid-flow pattern this product refuses everywhere else, and it
 * would do it over an event they may not have caused.
 *
 * IT CANNOT SAY WHO THE LINK IS FOR, and the copy is honest about that rather than inventing a
 * name. The ticket is opaque — that is the entire point of it — so this app genuinely does not know
 * whose account is behind it until the exchange, and the exchange is the thing being asked about.
 * The specification's wording assumes an email is available; it is not, and a prompt that guessed
 * would be a prompt that named the wrong person.
 */
export function SignInSwapPrompt() {
  const [ticket, setTicket] = useState<string | null>(null);
  const email = useSessionStore((s) => s.user?.email ?? null);

  useEffect(() => onAuthCallback((callback) => setTicket(callback.ticket)), []);

  if (!ticket) return null;

  const cancel = (): void => {
    setTicket(null);
    // FORGOTTEN, not deferred. Somebody said no; a ticket kept for the next screen that claims
    // readiness would sign them out the moment they happened to sign out and back in.
    clearAuthCallback();
    clearNonce();
  };

  return (
    // A strip rather than a modal, in the same place `AdminModeBanner` and `EnforcementStrip` sit —
    // above every pane and below the top bar. It is about the whole session rather than about
    // whatever is on screen, which is exactly what those two are about too.
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-panel px-4 py-2.5">
      <span className="text-[12px] leading-[1.5] text-ink">
        A sign-in link opened Jaroku.
        {email ? (
          <span className="text-muted"> Continuing will sign out {email}.</span>
        ) : (
          <span className="text-muted"> Continuing will end this session.</span>
        )}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={cancel}
          className="rounded-control px-2.5 py-1 text-[12px] text-muted outline-none transition-colors duration-fast hover:text-ink focus-visible:shadow-focusring"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const pending = ticket;
            setTicket(null);
            // SIGN OUT FIRST, THEN LET THE FLOW SPEND IT. Signing out unmounts the app and mounts
            // `AuthFlow`, which claims the callback and exchanges it — so the swap goes through the
            // one code path that already knows how, rather than through a second copy of it here.
            // The ticket is re-offered rather than passed, because `AuthFlow` is the only thing
            // that should ever hold one.
            void import("../../lib/authLink.ts").then((m) => {
              useSessionStore.getState().signOut(null);
              m.offerAuthCallback({ ticket: pending });
            });
          }}
          className="rounded-control bg-ink px-2.5 py-1 text-[12px] font-medium text-void outline-none transition-shadow duration-base hover:shadow-glow-cta focus-visible:shadow-focusring"
        >
          Continue
        </button>
      </span>
    </div>
  );
}

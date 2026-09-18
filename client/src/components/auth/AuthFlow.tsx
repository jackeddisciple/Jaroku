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
import { onAuthCallback } from "../../lib/authLink.ts";
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
  | { at: "sent"; email: string; expiresInMinutes: number; poll: string | null }
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
          <h1 className="text-display text-ink">Signing you in</h1>
        </Reveal>
        <Reveal delay={60}>
          <p className="mx-auto mt-3 max-w-[34ch] text-body text-muted">
            One moment — finishing up.
          </p>
        </Reveal>
      </AuthNotice>
    );
  }

  if (screen.at === "expired") {
    return (
      <AuthNotice>
        <h1 className="text-display text-ink">That link expired</h1>
        <p className="mx-auto mt-3 max-w-[38ch] text-label leading-[1.6] text-muted">
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
        poll={screen.poll}
        onTicket={(ticket) => void spend(ticket)}
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
      onSent={(email, expiresInMinutes, poll) => setScreen({ at: "sent", email, expiresInMinutes, poll })}
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
export function SignInSwapHandler() {
  const [ticket, setTicket] = useState<string | null>(null);
  const email = useSessionStore((s) => s.user?.email ?? null);

  useEffect(() => onAuthCallback((callback) => setTicket(callback.ticket)), []);

  /**
   * A LINK IS SPENT, NEVER ASKED ABOUT — the product owner's call, and it replaced a confirmation
   * strip that turned up on ordinary sign-ins.
   *
   * WHAT IT USED TO DO. §4.5 asked for a prompt when a link arrives while somebody is signed in:
   * "A sign-in link opened Jaroku. Continuing will sign out <email>", with Cancel and Continue. The
   * case it was written for is a link belonging to somebody ELSE being opened on your machine, and
   * swapping silently there would be indefensible.
   *
   * WHY IT WENT ANYWAY. It cannot tell that case from the ordinary one, because the ticket is
   * OPAQUE — that is the entire point of a ticket — so this app does not know whose account is
   * behind it until the exchange, and the exchange is the thing being asked about. What it CAN see
   * is that somebody is signed in, which is true every time a person whose session is still live
   * clicks their own link. So the strip asked "shall I sign out Adarsh?" of Adarsh, who had just
   * asked to be signed in, and the only true answer was yes.
   *
   * SO THE SWAP IS SILENT AND THIS DRAWS NOTHING. It was not simply deleted, because it is still
   * the only thing that claims a ticket while a session is live: `AuthFlow` mounts only when signed
   * out, so with nothing here a link clicked by a signed-in person would be offered, claimed by
   * nobody, and appear to do nothing at all.
   *
   * SIGN OUT FIRST, THEN LET THE FLOW SPEND IT. Signing out unmounts the app and mounts `AuthFlow`,
   * which claims the callback and exchanges it — so the swap goes through the one code path that
   * already knows how rather than through a second copy of it here. The ticket is re-offered rather
   * than passed, because `AuthFlow` is the only thing that should ever hold one.
   */
  useEffect(() => {
    if (!ticket) return;
    setTicket(null);
    void import("../../lib/authLink.ts").then((m) => {
      if (email) useSessionStore.getState().signOut(null);
      m.offerAuthCallback({ ticket });
    });
  }, [ticket, email]);

  return null;
}

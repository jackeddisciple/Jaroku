// §3.1 — the one screen somebody who is not signed in ever sees.
//
// TWO PATHS, AND THEY ARE DELIBERATELY THE SAME SIZE. The specification is unusually direct about
// this and it is worth quoting rather than paraphrasing: "Both buttons appear equally valid. Google
// is primary in visual weight because it's the majority path, but 'Continue with email' is not
// buried as a 'more options' link — that's the pattern that quietly kills the alternative path for
// legitimate users who prefer it." So both are full-width controls of the same height and the same
// radius, differing in fill and in nothing else, and the email field is on the screen rather than
// behind a disclosure.
//
// NO "SIGN UP" VERSUS "SIGN IN". Same field, same button, same flow, and the server decides whether
// this is a new account or an existing one. That is not a simplification — it is the thing that
// stops somebody bouncing between two forms trying to remember which state they are in, and it is
// the reason the legal line says "by continuing" rather than sitting under a Create Account button.
//
// WHAT IT RENDERS IS WHAT THE SERVER CAN ACTUALLY DO. `signInMethods()` is asked once and the
// controls follow: a "Continue with Google" that 404s is worse than no Google at all, and the
// client cannot know without asking. The dev sign-in appears only where the server has a local
// issuer AND neither real path is configured — on a packaged desktop install both of the real ones
// are there and this is a form nobody sees.

import { useEffect, useState } from "react";
import { devSignIn, localIssuerAvailable } from "../../lib/auth.ts";
import { pendingInvite } from "../../lib/invite.ts";
import { SignInFailure, signInMethods, startGoogleSignIn, type SignInMethods } from "../../lib/signIn.ts";
import { restartSocket } from "../../lib/socket.ts";
import { useSessionStore } from "../../store/sessionStore.ts";
import { backendHasFailed, useHostStore } from "../../store/hostStore.ts";
import { ICON } from "../../lib/tokens.ts";
import { BackendFailure } from "../BackendFailure.tsx";
import { AuthShell, LegalLine } from "./AuthShell.tsx";
import { FormError, OrDivider, PrimaryButton, SecondaryButton, TextField } from "./controls.tsx";
import { Reveal } from "../onboarding/Reveal.tsx";

/**
 * Google's mark, inline.
 *
 * DRAWN RATHER THAN FETCHED, for the reason every other icon in this product is: nothing here is
 * loaded from a CDN, and a sign-in button whose logo depends on somebody else's uptime is a button
 * that renders as a gap on a bad day. The four colours are Google's own and are required by their
 * branding terms — this is the one mark in the entire application that is not monochrome, and it is
 * an obligation rather than a decision.
 */
function GoogleMark() {
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.06 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.38Z" />
      <path fill="#34A853" d="M12 23.5c3.1 0 5.71-1.03 7.62-2.79l-3.72-2.88c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.75H1.7v2.98A11.5 11.5 0 0 0 12 23.5Z" />
      <path fill="#FBBC05" d="M5.55 14.18a6.9 6.9 0 0 1 0-4.36V6.84H1.7a11.5 11.5 0 0 0 0 10.32l3.85-2.98Z" />
      <path fill="#EA4335" d="M12 4.75c1.69 0 3.2.58 4.4 1.72l3.3-3.3C17.7 1.3 15.1.25 12 .25A11.5 11.5 0 0 0 1.7 6.84l3.85 2.98C6.46 7.1 9 4.75 12 4.75Z" />
    </svg>
  );
}

export function SignInScreen({
  onEmail,
}: {
  /** §3.3 step 1. Handing the address up rather than sending it here — see the note at the call. */
  onEmail: (email: string) => void;
}) {
  const message = useSessionStore((s) => s.message);
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"google" | "email" | "dev" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devName, setDevName] = useState("");

  // Read once, at mount. The URL cannot change under this screen — there is no router — and the
  // redemption that removes the parameter only runs once there is a session, which is the moment
  // this screen stops being rendered.
  const [invited] = useState(() => pendingInvite() !== null);

  // WHAT THE HOST SAYS, WHICH OUTRANKS EVERYTHING BELOW IT. In a browser this is null forever. Under
  // the desktop shell it is the difference between "this server offers no Google" and "there is no
  // server" — two states this screen would otherwise render identically, as a panel with one form
  // on it and no way forward.
  const backend = useHostStore((s) => s.status);
  const backendFailed = backendHasFailed(backend);

  // `attempt` is what makes the retry real, and the loop is `localIssuerAvailable`'s: it waits about
  // ninety seconds for a backend that is still starting and then answers. On a launch that took
  // longer, or one the shell has since recovered from, this screen used to be permanently stuck on
  // an answer that had stopped being true.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setMethods(null);
    void (async () => {
      // The probe first, because it is the one with the retry loop in it — asking `/v1/auth/methods`
      // against a backend that is not listening yet would answer "nothing is offered" once and for
      // the life of the screen.
      await localIssuerAvailable();
      if (!live) return;
      const offered = await signInMethods();
      if (!live) return;
      setMethods(offered);
      useSessionStore.getState().setLocalIssuer(offered.localIssuer);
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const google = async (): Promise<void> => {
    if (busy) return;
    setBusy("google");
    setError(null);
    try {
      await startGoogleSignIn();
      // BUSY STAYS SET. The browser is open and the next thing that happens is a deep link waking
      // this window — there is nothing here to un-busy, and a button that came back to life would
      // invite a second flow whose state token invalidates the first one's.
    } catch (err) {
      setError(err instanceof SignInFailure ? err.message : String(err));
      setBusy(null);
    }
  };

  const submitEmail = (e: React.FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!address) return;
    setError(null);
    // HANDED UP RATHER THAN SENT FROM HERE, and the reason is which screen owns the result. §3.3
    // step 4 is a whole screen — "check your email", a resend countdown, a way back — and it needs
    // the address. Sending the request here and then telling the parent would mean two places knew
    // how to ask for a link, and the one that did not send it would be the one rendering the state.
    onEmail(address);
  };

  const devSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy("dev");
    setError(null);
    try {
      await devSignIn(email.trim(), devName.trim() || undefined);
      useSessionStore.getState().setStatus("connecting");
      restartSocket();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  // THE HOST'S VERDICT COMES FIRST, and every branch below is guarded on it. The check those
  // branches read asks the SERVER a question, and there is no server — so it would time out and
  // then render a screen with nothing on it that works.
  if (backendFailed && backend) {
    return (
      <AuthShell title="Jaroku can't start" mark subtitle="The part of Jaroku that does the work did not come up.">
        <BackendFailure status={backend} onRetry={() => setAttempt((n) => n + 1)} />
      </AuthShell>
    );
  }

  const realMethods = methods ? methods.google || methods.magicLink : false;
  // The dev form appears only where there is no real path at all. On a packaged install both real
  // paths exist and this is a form nobody ever sees.
  const devOnly = methods !== null && !realMethods && methods.localIssuer;

  return (
    <AuthShell
      title="Welcome to Jaroku"
      subtitle={
        <>
          Your native workbench for
          <br />
          building trustworthy AI agents.
        </>
      }
      footnote={<LegalLine />}
    >
      {/* WHY THEY ARE HERE, when they did not arrive by choice: a revoked membership, an expired
          token, a server that stopped trusting this session. Above the controls, because it is the
          answer to the question somebody is asking as the screen appears. */}
      {message && (
        <p className="mb-5 rounded-control border border-edge bg-void px-3 py-2.5 text-[12px] leading-[1.5] text-muted">
          {message}
        </p>
      )}

      {/* AN INVITATION SURVIVES THIS SCREEN, and saying so is the difference between a link that
          works and one that appears to have dropped somebody at a login form for no reason. The
          token stays in the URL until there is a session to spend it with — see lib/invite.ts — so
          nothing here has to carry it. */}
      {invited && (
        <p className="mb-5 rounded-control border border-edge bg-void px-3 py-2.5 text-[12px] leading-[1.5] text-muted">
          You have been invited to a workspace. Sign in and it will be accepted for you.
        </p>
      )}

      {methods === null && (
        <p className="py-2 text-center text-[13px] text-muted">Checking how this server signs people in…</p>
      )}

      {methods !== null && realMethods && (
        <Reveal>
          <div className="flex flex-col gap-4">
            {methods.google && (
              <SecondaryButton onClick={() => void google()} disabled={busy !== null} icon={<GoogleMark />}>
                {busy === "google" ? "Waiting for your browser…" : "Continue with Google"}
              </SecondaryButton>
            )}

            {methods.google && methods.magicLink && <OrDivider />}

            {methods.magicLink && (
              <form onSubmit={submitEmail} className="flex flex-col gap-4">
                <TextField
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="Enter your email"
                  ariaLabel="Email address"
                  autoFocus={!methods.google}
                  disabled={busy !== null}
                  maxLength={254}
                  icon={
                    <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON.strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  }
                />
                <PrimaryButton type="submit" disabled={busy !== null || email.trim().length === 0}>
                  Continue with email
                </PrimaryButton>
              </form>
            )}

            {error && <FormError>{error}</FormError>}
          </div>
        </Reveal>
      )}

      {/* THE DEVELOPMENT SIGN-IN, and it says out loud what it is. Reached only on a server with a
          local issuer and no real provider configured, which is `npm run dev` and nothing else. */}
      {devOnly && (
        <form onSubmit={devSubmit} className="flex flex-col gap-4">
          <p className="text-[11px] leading-[1.6] text-muted">
            This server is running its own local issuer. The token it mints is real and is verified
            exactly the way a provider&rsquo;s is &mdash; but there is no password, so anyone who can
            reach this port can sign in as anyone. Development only.
          </p>
          <TextField
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            ariaLabel="Email address"
            autoFocus
            disabled={busy !== null}
          />
          <TextField
            value={devName}
            onChange={setDevName}
            placeholder="Your name (optional)"
            ariaLabel="Display name"
            disabled={busy !== null}
          />
          {error && <FormError>{error}</FormError>}
          <PrimaryButton type="submit" disabled={busy !== null || email.trim().length === 0}>
            {busy === "dev" ? "Signing in…" : "Sign in"}
          </PrimaryButton>
        </form>
      )}

      {/* A SERVER THAT OFFERS NOTHING, which is a real configuration: an external identity provider
          is in front of it and this app is not where you sign in. It used to be a screen with
          nothing on it to press. */}
      {methods !== null && !realMethods && !devOnly && (
        <div className="space-y-3 text-[13px] leading-[1.6] text-muted">
          <p>This server verifies tokens against an external identity provider.</p>
          <p className="text-[11px]">
            Sign in there and this window will pick the session up. The server has no sign-in form of
            its own &mdash; it never sees a password, only a token it can verify.
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-control border border-edge px-2.5 py-1 text-[11px] text-muted outline-none hover:border-chrome hover:text-ink focus-visible:shadow-focusring"
          >
            Check again
          </button>
        </div>
      )}
    </AuthShell>
  );
}

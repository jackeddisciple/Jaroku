// §3.3 step 4 — the screen somebody is looking at while a message is in flight.
//
// IT IS THE ONE SCREEN IN THIS FLOW WHERE NOTHING HAPPENS, and that is what it has to be designed
// for. Every other screen is waiting on a click; this one is waiting on a mail provider, a DNS
// lookup, a spam filter and a person switching applications — and the whole of its job is to make
// the gap legible rather than anxious. Three sentences and a countdown.
//
// THE COUNTDOWN IS NOT THE RATE LIMIT, and conflating the two would be a mistake in both
// directions. The limit is three an hour and lives on the server, where it belongs; this is
// forty-five seconds and lives here, where it can be WATCHED. A person whose mail is three seconds
// slow does not need to be told they have used one of three attempts — they need to see a number
// going down, which is the difference between "it is coming" and "nothing happened".
//
// AND THERE IS NO "RESEND TO A DIFFERENT ADDRESS". §3.3 is explicit: "If the user typed the wrong
// address, they use 'Start over' — resending to a different address on the same session is a
// phishing surface." So the way back is a full restart, and it is a link rather than a button
// because it is the quieter of the two things on offer.

import { useEffect, useState } from "react";
import { RESEND_COOLDOWN_S } from "../../lib/signInTiming.ts";
import { SignInFailure, requestMagicLink } from "../../lib/signIn.ts";
import { AuthShell, LegalLine, TextLink } from "./AuthShell.tsx";
import { FormError } from "./controls.tsx";

export function CheckEmailScreen({
  email,
  expiresInMinutes,
  onStartOver,
}: {
  email: string;
  /** From the server, so this sentence and the token's own lifetime cannot drift apart. */
  expiresInMinutes: number;
  onStartOver: () => void;
}) {
  // SECONDS REMAINING, NOT A TIMESTAMP TO COMPARE AGAINST. This is the only clock on the screen and
  // it counts down from the moment the screen appears — which is a moment this component knows and
  // the server does not, because the server's answer is about the token rather than about the wait.
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_S);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (remaining <= 0) return;
    // ONE SECOND AT A TIME RATHER THAN A SINGLE TIMEOUT, because the number is rendered. A timeout
    // that fired once at the end would leave "Resend in 45s" on screen for forty-five seconds,
    // which reads as a frozen screen — the exact impression this whole screen exists to avoid.
    const timer = setTimeout(() => setRemaining((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const resend = async (): Promise<void> => {
    if (busy || remaining > 0) return;
    setBusy(true);
    setError(null);
    try {
      await requestMagicLink(email);
      setResent(true);
      setRemaining(RESEND_COOLDOWN_S);
    } catch (err) {
      // §10 AND §3.3'S LIMIT BOTH LAND HERE, and both are worth saying out loud. A 429 means they
      // have asked three times in an hour and the honest answer is to wait or use Google; a 502
      // means our provider is down, which is not their fault and not something waiting fixes.
      setError(
        err instanceof SignInFailure
          ? err.message
          : "couldn't send another link right now — try again in a minute",
      );
    } finally {
      setBusy(false);
    }
  };

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
      <div className="flex flex-col gap-4 text-center">
        <p className="text-[13px] leading-[1.7] text-muted">
          We sent a sign-in link to the email address{" "}
          {/* THE ADDRESS IS RENDERED IN INK, because it is the one thing on this screen somebody has
              to check. The commonest reason a link "never arrives" is a typo, and the fix for that
              is below — but only if the mistake is visible. `break-all` because an address is not a
              word and a long one would otherwise widen the card. */}
          <span className="break-all font-medium text-ink">{email}</span>.
        </p>
        <p className="text-[13px] leading-[1.7] text-muted">
          Please open your inbox and click the link to continue signing in to your{" "}
          <span className="text-ink">Jaroku account</span>.
        </p>
        <p className="text-[13px] leading-[1.7] text-muted">
          The link expires in <span className="font-medium text-ink">{expiresInMinutes}</span>{" "}
          {expiresInMinutes === 1 ? "minute" : "minutes"}.
        </p>

        <div className="mt-2 flex flex-col gap-3 border-t border-hair pt-5">
          <p className="text-[13px] leading-[1.6] text-muted">
            Wrong email? <TextLink onClick={onStartOver}>Start over</TextLink>
          </p>

          {/* THE COUNTDOWN IS TEXT UNTIL IT IS A LINK. A disabled button that becomes enabled is the
              same control in two states and reads as one thing you cannot press yet; a sentence
              that turns into a link reads as a wait that ended. */}
          <p className="text-[13px] leading-[1.6] text-muted" aria-live="polite">
            {remaining > 0 ? (
              <>Didn&rsquo;t get it? Resend in {remaining}s</>
            ) : busy ? (
              <>Sending another link…</>
            ) : (
              <>
                Didn&rsquo;t get it? <TextLink onClick={() => void resend()}>Send another link</TextLink>
              </>
            )}
          </p>

          {/* SAID ONCE, QUIETLY, AND ONLY AFTER A RESEND. A confirmation on the first send would be
              redundant with the three sentences above it; after a resend it is the only evidence
              that pressing the link did anything at all, since the screen is otherwise identical. */}
          {resent && remaining > 0 && !error && (
            <p className="text-[12px] leading-[1.6] text-ok">Sent. Check your inbox again in a moment.</p>
          )}

          {error && <FormError>{error}</FormError>}

          {/* THE ONE PIECE OF ADVICE WORTH GIVING, and it is the one that actually resolves most of
              these. It is last and it is the quietest thing on the screen, because somebody whose
              mail arrived in two seconds should never have read it. */}
          <p className="text-[11px] leading-[1.6] text-faint">
            Still nothing? Check your spam folder — and if the address above is wrong, start over.
          </p>
        </div>
      </div>
    </AuthShell>
  );
}

// §2 — the three screens between installing Jaroku and signing into it, plus the two that say why
// it did not work.
//
// IT OWNS THE WHOLE SURFACE, like the sign-in screen does and for a stronger reason. There is no
// session, so there is no workspace; and there is no RUNTIME either, so there is not even a backend
// to have a session against. Every panel in the app is a view of one workspace's data and none of
// them could render anything at all.
//
// WHAT IS ON SCREEN IS DERIVED, NEVER DECIDED HERE. Which of the five states shows is a reading of
// the progress the shell publishes — `firstRun.ts` — and this component holds exactly one piece of
// state of its own: whether the person has pressed "Get started" yet. That is deliberate and it is
// the same rule `useOnboarding` follows: onboarding is a reading of the app's own progress, not a
// parallel record of it. A component that tracked its own idea of which step was running would be
// a second source of truth that goes stale the moment a retry resets the first.
//
// AND IT IS NEVER RENDERED IN A BROWSER. `progress.required` is false there forever, because a
// browser has no `~/.jaroku` to set up and never did. `npm run dev` in a tab is unchanged.

import { useEffect, useState } from "react";
import {
  activeStep,
  failedStep,
  quitApp,
  retryFirstRun,
  type FirstRunProgress,
  type FirstRunStep,
} from "../../lib/firstRun.ts";
import { HELP_URLS, openExternal } from "../../lib/openExternal.ts";
import { authCallbackPending } from "../../lib/authLink.ts";
import { ICON } from "../../lib/tokens.ts";
import { AuthNotice, AuthShell, TextLink } from "../auth/AuthShell.tsx";
import { PrimaryButton, QuietButton, SecondaryButton } from "../auth/controls.tsx";
import { Reveal } from "../onboarding/Reveal.tsx";

export function FirstRun({
  progress,
  onDone,
}: {
  progress: FirstRunProgress;
  /** Called from screen 3's button. The marker is already written by then; this is the transition. */
  onDone: () => void;
}) {
  // THE ONE PIECE OF LOCAL STATE, and §2.1 is why it exists: screen 1 has nothing to configure and
  // one button, and it exists "because launching straight into a technical dependency check reads
  // as hostile". So the check is running underneath while somebody reads a sentence.
  const [started, setStarted] = useState(false);

  // EXCEPT WHEN A LINK IS ALREADY WAITING. Somebody clicked a magic link, the OS started this
  // application with the URL, and first-run is what stands between them and being signed in — see
  // §4.5's "deep-link arrives while first-run is incomplete: queue it". A welcome screen in front
  // of that is a click asking somebody to confirm they meant the thing they already did.
  useEffect(() => {
    if (authCallbackPending()) setStarted(true);
  }, []);

  const failed = failedStep(progress);
  if (failed) {
    return progress.offline ? (
      <OfflineScreen step={failed} logPath={progress.logPath} />
    ) : (
      <FailureScreen step={failed} message={progress.message} logPath={progress.logPath} />
    );
  }
  if (progress.complete) return <ReadyScreen onDone={onDone} />;
  if (!started) return <WelcomeScreen onStart={() => setStarted(true)} />;
  return <RuntimeScreen progress={progress} />;
}

// --- screen 1 -------------------------------------------------------------------------------

/**
 * §2.1's first screen. "Nothing to configure here. Single 'Get started' button."
 *
 * The last line is the one worth keeping honest: somebody who already uses Jaroku on another
 * machine is looking at a setup screen and needs to know they are not about to make a second
 * account. Saying so here costs one sentence and saves a support conversation.
 */
function WelcomeScreen({ onStart }: { onStart: () => void }) {
  return (
    <AuthShell
      title="Welcome to Jaroku"
      subtitle={
        <>
          A workbench for building AI agents
          <br />
          you can actually trust.
        </>
      }
      footnote={
        <>
          Already have Jaroku set up on another device? Signing in works the same way, and
          everything you have made is waiting.
        </>
      }
    >
      <Reveal delay={120}>
        <PrimaryButton onClick={onStart} autoFocus>
          Get started
        </PrimaryButton>
      </Reveal>
    </AuthShell>
  );
}

// --- screen 2 -------------------------------------------------------------------------------

/**
 * §2.1's second screen: four rows, one of them in flight.
 *
 * THE IN-FLIGHT TREATMENT IS THE APP'S OWN. `stream-pulse` on the current row, a static ✓ for
 * complete and a static ○ for pending — the same three states every other in-flight indicator in
 * this product uses, so the very first thing somebody sees is already teaching them the vocabulary
 * the trace panel will use in ten minutes.
 */
function RuntimeScreen({ progress }: { progress: FirstRunProgress }) {
  const running = activeStep(progress);
  return (
    <AuthShell
      title="Setting up Jaroku"
      subtitle="This runs once on this device. About thirty seconds on a good connection."
      footnote={
        // The detail line lives here rather than under its row, because uv's output is one long
        // line and putting it inside a 420px card would either wrap to four lines or truncate the
        // only informative part. Outside, centred, quiet, and it changes as the install moves.
        running?.detail ? <span className="text-tiny text-faint">{running.detail}</span> : null
      }
    >
      <ul className="flex flex-col gap-4">
        {progress.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>
    </AuthShell>
  );
}

function StepRow({ step }: { step: FirstRunStep }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-[1px] shrink-0">
        <StepMark step={step} />
      </span>
      <span className="min-w-0">
        <span
          className={`block text-label leading-[1.4] ${
            step.state === "pending" ? "text-faint" : "text-ink"
          } ${step.state === "running" ? "animate-stream-pulse motion-reduce:animate-none" : ""}`}
        >
          {step.label}
        </span>
        {/* Only on the rows that have FINISHED, and only when the shell had something to say — the
            interpreter's version, where storage went. The running row's detail is the footnote
            above, because it changes several times a second and a line that reflows inside a list
            makes the list jump. */}
        {step.detail && step.state === "done" && (
          <span className="mt-0.5 block truncate text-tiny leading-[1.4] text-faint">{step.detail}</span>
        )}
      </span>
    </li>
  );
}

function StepMark({ step }: { step: FirstRunStep }) {
  const size = ICON.sm;
  if (step.state === "done") {
    return (
      <span className="block text-ok animate-check-in motion-reduce:animate-none">
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON.strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-label="done">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (step.state === "failed") {
    return (
      <span className="block text-err">
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON.strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-label="failed">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </span>
    );
  }
  if (step.state === "running") {
    // AMBER, which is this product's in-flight colour everywhere else — the executing graph node,
    // the streaming step, the running eval. A spinner would be a fifth vocabulary for a state the
    // app already has four consistent spellings of.
    return (
      <span className="block text-run animate-stream-pulse motion-reduce:animate-none" aria-label="in progress">
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON.strokeWidth} strokeLinecap="round">
          <circle cx="12" cy="12" r="9" opacity="0.3" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </svg>
      </span>
    );
  }
  return (
    <span className="block text-faint" aria-label="waiting">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON.strokeWidth}>
        <circle cx="12" cy="12" r="8" />
      </svg>
    </span>
  );
}

// --- screen 3 -------------------------------------------------------------------------------

/** §2.1's third screen. The marker is already on disk by the time this renders; see firstrun.rs. */
function ReadyScreen({ onDone }: { onDone: () => void }) {
  return (
    <AuthNotice>
      <Reveal>
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-ok/30 bg-ok/10 text-ok animate-check-in motion-reduce:animate-none">
          <svg width={ICON.md * 1.5} height={ICON.md * 1.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      </Reveal>
      <Reveal delay={60}>
        <h1 className="mt-7 text-display text-ink">
          Your device is ready
        </h1>
      </Reveal>
      <Reveal delay={120}>
        <p className="mx-auto mt-3 max-w-[34ch] text-body text-muted">
          Next, sign in with your Google account or your email address.
        </p>
      </Reveal>
      <Reveal delay={200}>
        <div className="mx-auto mt-9 max-w-[300px]">
          <PrimaryButton onClick={onDone} autoFocus>
            Continue to sign in
          </PrimaryButton>
        </div>
      </Reveal>
    </AuthNotice>
  );
}

// --- the two ways it does not work ------------------------------------------------------------

/**
 * §2.2 — the one step that needs the network, without one.
 *
 * "Step 3 fails cleanly with a 'You're offline' screen, a retry button, and no scary error
 * messages." So there is no error text on this screen at all: what uv actually said is in the log,
 * the log path is offered under "Get help", and what is on screen is the one sentence that is both
 * true and actionable.
 */
function OfflineScreen({ step, logPath }: { step: FirstRunStep; logPath: string | null }) {
  return (
    <Recovery
      title="You're offline"
      body={
        <>
          Jaroku needs to download the Python packages your agents run on. Everything else on this
          device is already set up — reconnect and this will pick up where it left off.
        </>
      }
      step={step}
      logPath={logPath}
      retryLabel="Try again"
    />
  );
}

/**
 * §2.3 — "Any step that fails displays a clear error with three actions: Retry, Get help, and
 * Quit. No silent failures, no 'restart the app' as the only remedy."
 */
function FailureScreen({
  step,
  message,
  logPath,
}: {
  step: FirstRunStep;
  message: string | null;
  logPath: string | null;
}) {
  return (
    <Recovery
      title="Setup didn't finish"
      body={message ?? "Something went wrong while setting Jaroku up on this device."}
      step={step}
      logPath={logPath}
      retryLabel="Retry setup"
    />
  );
}

/**
 * The shape both failures take, because they differ in wording and in nothing else.
 *
 * THE THREE ACTIONS ARE ALWAYS THREE. Retry is filled because it is the one that fixes a
 * transient problem, which most of these are; Get help and Quit are quiet, because they are the
 * two things somebody does when it is not transient — and a screen where all three are equally
 * loud is a screen that has not said what to try first.
 */
function Recovery({
  title,
  body,
  step,
  logPath,
  retryLabel,
}: {
  title: string;
  body: React.ReactNode;
  step: FirstRunStep;
  logPath: string | null;
  retryLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [canQuit, setCanQuit] = useState(true);

  const retry = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const problem = await retryFirstRun();
    // NOT CLEARED ON SUCCESS. A retry that started leaves this screen the moment the first progress
    // event arrives — which is the shell's job to say, not this component's to guess. Setting busy
    // back to false here would make the button live again for the frame before that.
    if (problem) {
      setRefused(problem);
      setBusy(false);
    }
  };

  return (
    <AuthNotice>
      <h1 className="text-display text-ink">{title}</h1>
      <p className="mx-auto mt-3 max-w-[40ch] text-label leading-[1.6] text-muted">{body}</p>

      {/* WHICH STEP, NAMED. "Setup didn't finish" is the sentence; this is the fact somebody puts
          in a bug report, and it is the difference between a report that can be acted on and one
          that says the app did not work. */}
      <p className="mt-4 text-tiny uppercase tracking-wider text-faint">
        stopped at &ldquo;{step.label}&rdquo;
      </p>

      <div className="mx-auto mt-8 flex max-w-[300px] flex-col gap-3">
        <PrimaryButton onClick={() => void retry()} disabled={busy} autoFocus>
          {busy ? "Trying again…" : retryLabel}
        </PrimaryButton>
        <SecondaryButton onClick={() => void openExternal(HELP_URLS.firstRunHelp)}>
          Get help
        </SecondaryButton>
        {canQuit && (
          <QuietButton
            onClick={() => {
              // `false` means there was no application to quit, which is the browser — and in a
              // browser a Quit button is a lie. It removes itself rather than doing nothing.
              void quitApp().then((quit) => setCanQuit(quit));
            }}
          >
            Quit Jaroku
          </QuietButton>
        )}
      </div>

      {refused && (
        <p role="alert" className="mx-auto mt-5 max-w-[40ch] text-caption leading-[1.5] text-err">
          {refused}
        </p>
      )}

      {/* OFFERED, NEVER PRINTED. A log is something somebody copies into a bug report; it is not a
          UI, and forty lines of uv output on this screen would bury the three buttons. */}
      {logPath && (
        <p className="mt-8 text-tiny leading-[1.6] text-faint">
          The full log is at <span className="font-mono text-muted">{logPath}</span>
          {" — "}
          <TextLink href={HELP_URLS.firstRunHelp}>what to send us</TextLink>
        </p>
      )}
    </AuthNotice>
  );
}

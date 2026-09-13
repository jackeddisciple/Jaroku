// §5.1 step 3 — connect the subscription Jaroku Chat runs on.
//
// WHAT THIS STEP USED TO BE, AND WHY IT IS NOT ANY MORE. It asked for an API key, because for most
// of this product's life a key was the only credential there was. It is now the wrong question to
// open with: talking to Jaroku spends the plan somebody already pays Anthropic or OpenAI for, and
// step 4 immediately asks them to describe an agent — which IS a chat turn. Asking for an API key
// here put the credential for AGENT RUNS in front of somebody who could not yet send the message
// that creates an agent, and then let them through to a composer that refused to send.
//
// THE API KEY DID NOT MOVE HERE, IT MOVED OUT. It lives in Secrets, where every other credential
// lives, behind the passcode gate that exists for exactly that. The product owner's instruction on
// 2026-09-13 was plain: "User can't send manually go to secrets and put that." So this screen has
// one job and one credential system on it.
//
// THERE IS NO BUTTON THAT SIGNS ANYBODY IN, and there cannot be one. Neither provider permits a
// third-party application to carry out its sign-in — that is the whole reason this integration is
// permissible at all. The user runs `claude auth login` or `codex login` themselves, in their own
// terminal, through the provider's own browser flow, and Jaroku then asks the CLI what happened.
// A button here would be theatre around a line somebody still has to type.
//
// SKIP IS STILL FIRST-CLASS. §5.1 says it in bold and it is still true: somebody can look around
// before connecting anything. What a skip buys is the whole app with Chat disabled and a control
// that says why — not a dead end, and not a silent failure at the first message.

import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { ProviderSubscriptions, useSubscriptionConnected } from "../../ProviderSubscriptions.tsx";
import { StepShell } from "./StepShell.tsx";

export function ProviderStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const connected = useSubscriptionConnected();

  return (
    <StepShell
      step={3}
      title="Connect your provider"
      subtitle="Jaroku Chat runs on a Claude or Codex subscription you already have. Sign in with the provider's own command — the plan stays yours."
      skip={{ label: "Skip for now", onSkip: advance }}
      width="wide"
    >
      <div className="flex flex-col gap-5">
        <ProviderSubscriptions compact />

        <button
          type="button"
          onClick={advance}
          disabled={!connected}
          className="rounded-control bg-ink px-3 py-2 text-caption font-medium text-void outline-none
            transition-shadow duration-base hover:shadow-glow-cta focus-visible:shadow-focusring
            disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
        {!connected ? (
          // The disabled button says why, which is this product's rule everywhere else. Skip is
          // right there for somebody who would rather look around first.
          <p className="text-tiny text-faint">
            Connect one provider to continue, or skip and do it later in Settings.
          </p>
        ) : null}
      </div>
    </StepShell>
  );
}

// Connecting the provider subscription Jaroku Chat runs on, in the one place that knows how.
//
// TWO SURFACES, ONE COMPONENT. Onboarding asks for this before anybody can send a message, and
// Settings is where somebody changes it later — and they are the same question with the same
// answer, so they are the same component rather than two that drift. The only thing that differs
// is the frame around it, which is the caller's business.
//
// WHAT THIS IS NOT: an API-key form. Those live in Secrets and pay for AGENT RUNS against the
// user's API account. This is the OTHER credential system — the plan somebody already pays the
// provider for, which is what talking to Jaroku spends. The two never mix, and a control here that
// offered to take a key would be the exact substitution the architecture forbids.
//
// NOTHING HERE COLLECTS A CREDENTIAL, and it could not: the sign-in happens in the provider's own
// CLI, in the user's own terminal, through the provider's own browser flow. This screen prints the
// command and then asks the machine what happened. That is the whole of the interaction, and it is
// what makes the integration permissible rather than merely convenient.
//
// IT REFLECTS RATHER THAN DECIDES. Every row comes from the server's subscription snapshot, which
// checked what the provider permits BEFORE what the machine has. A provider can be installed and
// signed in and still read as unavailable — Muse Spark does, because Meta documents no third-party
// mechanism — and this component renders that truthfully rather than inventing a way to try anyway.

import { useCallback, useEffect, useState } from "react";

import { ProviderMark } from "../lib/icons.tsx";
import { reportHostProviders } from "../lib/socket.ts";
import { hasHost } from "../lib/hostProviders.ts";
import { useProviderStore } from "../store/providerStore.ts";
import type { SubscriptionStatus } from "../types.ts";

/** Whether any provider is connected — the one question the composer's gate asks. */
export function useSubscriptionConnected(): boolean {
  return useProviderStore((s) => s.subscriptions.some((r) => r.connected));
}

/** The rows worth showing: providers with an official mechanism. See the module note on Muse Spark. */
export function useConnectableSubscriptions(): SubscriptionStatus[] {
  return useProviderStore((s) => s.subscriptions.filter((r) => r.supported));
}

/** What a row's state is, in one word, so the badge and the copy agree. */
function stateOf(row: SubscriptionStatus): "connected" | "signed-out" | "missing" | "unavailable" {
  if (!row.available) return "unavailable";
  if (row.connected) return "connected";
  if (!row.host?.installed) return "missing";
  return "signed-out";
}

function Badge({ state }: { state: ReturnType<typeof stateOf> }) {
  const [label, tone] = state === "connected"
    ? ["Connected", "bg-ok/15 text-ok"]
    : state === "signed-out"
      ? ["Not signed in", "bg-warn/15 text-warn"]
      : state === "missing"
        ? ["Not installed", "bg-active text-muted"]
        : ["Unavailable", "bg-active text-faint"];
  return (
    <span className={`shrink-0 rounded-control px-1.5 py-0.5 text-tiny font-medium ${tone}`}>{label}</span>
  );
}

/**
 * One provider, and what to do about it.
 *
 * THE COMMAND IS THE INSTRUCTION. There is no button that signs somebody in, because there is no
 * way for this application to do that which the provider permits — and a button that opened a
 * terminal for them would be theatre around a line they still have to type. So the line is shown,
 * and the only control is "Check again", which re-asks the machine.
 */
function Row({ row }: { row: SubscriptionStatus }) {
  const state = stateOf(row);
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-edge bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderMark provider={row.provider} size={14} />
        <span className="text-caption font-medium text-ink">{row.label}</span>
        {row.host?.account ? (
          <span className="min-w-0 truncate text-tiny text-faint">{row.host.account}</span>
        ) : null}
        <span className="ml-auto" />
        <Badge state={state} />
      </div>

      {state === "connected" ? (
        <p className="text-tiny text-muted">
          Chat runs on your {row.label} plan. Usage counts against that plan, not against Jaroku.
        </p>
      ) : state === "unavailable" ? (
        // The provider's own reason, verbatim — paraphrasing a terms decision is how it drifts.
        <p className="text-tiny text-muted">{row.reason}</p>
      ) : (
        <>
          <p className="text-tiny text-muted">
            {state === "missing"
              ? `Install ${row.binary} on this machine, then sign in with your ${row.label} plan:`
              : `Sign in with your ${row.label} plan:`}
          </p>
          {/* A literal you type. §04 keeps the mono face to the code surfaces, so this reads as a
              command through its own panel and spacing rather than through a typeface. */}
          <p className="rounded-control bg-active px-2 py-1 text-tiny text-ink">{row.loginCommand}</p>
          {row.host?.signedIn === false && row.host.installed ? (
            <p className="text-tiny text-faint">
              Signed in with API credentials rather than a plan? Chat needs the plan sign-in. Your API
              key stays where it is and keeps powering agent runs.
            </p>
          ) : null}
        </>
      )}

      {row.credentialPath && state !== "unavailable" ? (
        <p className="text-tiny text-faint">Your sign-in stays in {row.credentialPath}. Jaroku never reads it.</p>
      ) : null}
    </div>
  );
}

/**
 * The list, plus the one control that changes anything: asking the machine again.
 *
 * RE-ASKED RATHER THAN POLLED. Somebody leaves, types a command in a terminal, and comes back —
 * that is a moment they can tell us about by pressing a button, and a timer that checked every few
 * seconds would spawn two processes a second for the whole time this screen is open.
 */
export function ProviderSubscriptions({ compact = false }: { compact?: boolean }) {
  const rows = useConnectableSubscriptions();
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await reportHostProviders();
    } finally {
      setChecking(false);
    }
  }, []);

  // Asked once on mount, so a screen somebody opened after signing in elsewhere is right without a
  // press. The socket already reported on connect; this covers everything that happened since.
  useEffect(() => { void recheck(); }, [recheck]);

  if (!hasHost()) {
    return (
      <p className="rounded-card border border-edge bg-panel px-3 py-2.5 text-caption text-muted">
        Connecting a provider subscription needs the Jaroku desktop app — Chat runs on the provider
        CLI installed on your own machine.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!compact ? (
        <p className="text-caption text-muted">
          Jaroku Chat runs on a subscription you already have. Sign in with the provider&rsquo;s own
          command and the plan stays yours — Jaroku never sees or stores the credential.
        </p>
      ) : null}
      {rows.map((row) => <Row key={row.provider} row={row} />)}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => { void recheck(); }}
          disabled={checking}
          className="rounded-control border border-edge px-2.5 py-1 text-caption text-muted outline-none transition-colors duration-fast hover:text-ink focus-visible:shadow-focusring disabled:opacity-60"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        <span className="text-tiny text-faint">
          After signing in, press this — Jaroku asks the CLI, it never watches the file.
        </span>
      </div>
    </div>
  );
}

// Step 2 — the credential ask, and the most important screen in the flow to get right.
//
// Two things it has to do. The first is say plainly what happens to the key, before asking for
// it: Jaroku is bring-your-own-key, the value goes to runtime/.env through the same writer
// every other credential goes through, and nothing sends it anywhere else. Those guarantees
// are already documented in the README's security notes, and a user should not have to go find
// that section to learn what a text field is about to do with their credential.
//
// The second is make skipping a real answer. The free dry-run path exercises the whole trace,
// graph and UI with real depth and no cost, so it is framed as a way to explore rather than as
// a lesser tier with a nag attached.

import { useState } from "react";
import { useProviderStore } from "../../store/providerStore.ts";
import { useUiStore } from "../../store/uiStore.ts";
import { BRAND_COLOR, ProviderMark } from "../../lib/icons.tsx";
import { ICON } from "../../lib/tokens.ts";
import { quietBtn } from "../buttons.ts";
import { ChevronDownIcon } from "../composerIcons.tsx";
import { KeyIcon, ShieldCheckIcon } from "../panelIcons.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { OnboardingSurface } from "./OnboardingSurface.tsx";
import { ProviderKeyForm } from "./ProviderKeyForm.tsx";

/** Display names, so the card heading and the continue button cannot drift apart. */
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** What each provider is FOR, which is the thing a chooser actually needs to know. */
const BLURB: Record<string, string> = {
  anthropic:
    "Powers Jaroku itself — planning, generation, the fix loop, explain and the eval judge — " +
    "and runs your agents on Claude.",
  openai: "Runs your agents on GPT models.",
};

export function ConnectProviderStep() {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const [open, setOpen] = useState<string | null>(null);
  const setStep = useUiStore((s) => s.setOnboardingStep);
  const setProvider = useUiStore((s) => s.setProvider);

  const proceed = () => setStep("prompt");

  const skip = () => {
    // The free path is a real configuration, not an absence of one: the run provider is set to
    // the dry-run model so the next screen is already pointed somewhere that works.
    setProvider("fake");
    proceed();
  };

  // The provider that is ALREADY connected, if any.
  //
  // Every other way off this screen goes through saving a key. That leaves out the person the
  // README tells to write runtime/.env by hand before ever opening the app: they arrive here,
  // see CONNECTED, and the only offers are "Try it free first" — which quietly points the next
  // screen at the dry-run provider — and re-typing a key they already have. Continuing with
  // what is already configured is the obvious answer and it was the one thing missing.
  const connected = providers.filter((p) => p.configured);
  const primary = connected.find((p) => p.powers_jaroku) ?? connected[0];

  const continueConnected = () => {
    // Same reasoning as skip(): point the next screen at something that works, which here is
    // the key the user already has rather than the dry-run model.
    if (primary) setProvider(primary.id);
    proceed();
  };

  return (
    <OnboardingSurface>
      <h1 className="text-[22px] font-semibold leading-tight text-ink">Connect a provider</h1>
      <p className="mt-2 text-[13px] leading-[1.6] text-muted">
        Jaroku runs on your own API keys — there is no Jaroku account, and nothing is proxied
        through us.
      </p>

      {/* The guarantees, before the field that needs them. */}
      <div className="mt-4 flex items-start gap-2.5 rounded-card border border-edge bg-panel px-3 py-2.5">
        <span className="mt-[2px] shrink-0 text-ok">
          <ShieldCheckIcon size={ICON.sm} />
        </span>
        <p className="text-[12px] leading-[1.6] text-muted">
          A key you enter is written to <span className="font-mono text-ink">runtime/.env</span>,
          which is gitignored, and read only by the Jaroku server process on this machine. It is
          never logged, never written into a generated project, never sent to any third party, and
          never sent back to this page — the browser only ever learns that a key is{" "}
          <span className="font-mono text-ink">set</span>. You can remove it by deleting one line
          from that file.
        </p>
      </div>

      {/* One card per provider the Python runtime actually supports (jaroku_runner/models.py).
          `fake` is deliberately absent: it is not something you connect, it is the skip path. */}
      <div className="mt-5 space-y-2">
        {!loaded && <p className="text-[12px] text-faint">Checking which providers are connected…</p>}
        {providers.map((p) => {
          const expanded = open === p.id;
          return (
            <div key={p.id} className="overflow-hidden rounded-card border border-edge">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : p.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-active/40"
              >
                <ProviderMark provider={p.id} size={16} />
                <span className="text-[13px] text-ink" style={{ color: BRAND_COLOR[p.id] }}>
                  {PROVIDER_LABEL[p.id] ?? p.id}
                </span>
                {p.configured && (
                  <StatusBadge state="ok" variant="outline" label="connected" icon={KeyIcon} />
                )}
                <span className="ml-auto flex items-center gap-2">
                  <span className="hidden text-[11px] text-faint sm:inline">
                    {p.configured ? "replace key" : "add a key"}
                  </span>
                  <span
                    className={`text-faint transition-transform duration-fast ${expanded ? "rotate-180" : ""}`}
                    aria-hidden
                  >
                    <ChevronDownIcon size={ICON.xs} />
                  </span>
                </span>
              </button>
              <div className="px-3 pb-3">
                <p className="mb-2 text-[12px] leading-[1.55] text-muted">{BLURB[p.id]}</p>
                {/* The one honest caveat the flow would otherwise hide until it bit somebody:
                    connecting OpenAI alone does not make Jaroku able to BUILD an agent, because
                    planning and generation are Anthropic-only (see the README's requirements). */}
                {!p.powers_jaroku && (
                  <p className="mb-2 text-[11px] leading-[1.55] text-faint">
                    Note: describing and generating agents goes through Anthropic. An OpenAI key
                    alone lets you run agents on GPT, not build them.
                  </p>
                )}
                {expanded && <ProviderKeyForm provider={p} onSaved={proceed} autoFocus />}
              </div>
            </div>
          );
        })}
      </div>

      {/* Continue on the key that is already there. Only once the snapshot has landed —
          before that, "nothing is configured" and "we have not been told yet" look the same,
          and a button that appears a beat late is worse than one that waits. */}
      {loaded && primary && (
        <button
          type="button"
          onClick={continueConnected}
          autoFocus
          className="mt-6 rounded-control px-6 py-2.5 text-[13px] font-medium transition-opacity
            hover:opacity-90 focus:outline-none focus:shadow-focusring"
          style={{ background: "#4f46e5", color: "#fff" }}
        >
          Continue with {PROVIDER_LABEL[primary.id] ?? primary.id}
        </button>
      )}

      {/* The skip. A sibling of the cards above, not a way out of them. */}
      <div className="mt-6 border-t border-hair pt-4">
        <button
          type="button"
          onClick={skip}
          className="text-[13px] text-ink underline decoration-hair underline-offset-4 transition-colors hover:decoration-ink"
        >
          Try it free first →
        </button>
        <p className="mt-1.5 max-w-[520px] text-[12px] leading-[1.6] text-faint">
          The dry-run provider costs nothing and is not a demo: it runs a real agent through the
          real graph and emits a real trace, so the timeline, the state diffs and the graph view
          all work exactly as they will with a paid key. Connect a provider any time from
          Settings, or from the provider chip in the top bar.
        </p>
      </div>

      {/* A way back, because a step you cannot leave is a trap even when it is the right step. */}
      <button type="button" className={`${quietBtn} mt-4 !px-0 !text-[11px]`} onClick={() => setStep("welcome")}>
        ← back
      </button>
    </OnboardingSurface>
  );
}

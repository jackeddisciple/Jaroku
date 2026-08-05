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
//
// The composition was fighting both of those. Three boxes of equal weight ran down the screen —
// the guarantee, then Anthropic, then OpenAI — so the promise about the key looked like a third
// provider, and the free path was a text link below a rule, which is where a product puts the
// thing it hopes you will not click. Now the page has exactly one kind of box, a card you can
// choose, and there are three of them: two providers and the free path. The guarantee stops
// being a box at all and becomes a note against a rule, which is what a footnote that must be
// read but not chosen actually looks like.

import { useState } from "react";
import { useProviderStore } from "../../store/providerStore.ts";
import { useUiStore } from "../../store/uiStore.ts";
import { BRAND_COLOR, ProviderMark } from "../../lib/icons.tsx";
import { ICON, SURFACE, TYPE } from "../../lib/tokens.ts";
import { quietBtn } from "../buttons.ts";
import { ChevronDownIcon } from "../composerIcons.tsx";
import { KeyIcon, PlusIcon, ShieldCheckIcon, ZapIcon } from "../panelIcons.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { OnboardingSurface } from "./OnboardingSurface.tsx";
import { PrimaryCta, GhostCta } from "./Cta.tsx";
import { ProviderKeyForm } from "./ProviderKeyForm.tsx";
import { Reveal } from "./Reveal.tsx";

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

/**
 * The card everything on this screen that can be CHOSEN is drawn as.
 *
 * Elevation by light, never by shadow (§4.2, and see GLOW): the border brightens and the edge
 * blooms when the pointer is over it or the keyboard is in it. On #0d0d0f that is the only
 * direction a surface can move — it cannot get darker than the page.
 *
 * `focus-within` rather than `focus-visible` for the glow, deliberately. This is not a focus
 * ring; it is the card saying it is the one you are working in, which is true whether you got
 * there by tab or by click, and stays true while you are typing a key into it. The ring proper
 * still lives on the controls inside.
 */
function ChoiceCard({
  tint,
  children,
}: {
  /** A brand colour, when the card has earned one. Undefined keeps it neutral. */
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-card border bg-panel/50 transition-shadow duration-base ease-state
        hover:shadow-glow focus-within:shadow-glow"
      style={{ borderColor: tint ? `${tint}33` : SURFACE.edge }}
    >
      {children}
    </div>
  );
}

export function ConnectProviderStep() {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const [open, setOpen] = useState<string | null>(null);
  const setStep = useUiStore((s) => s.setOnboardingStep);
  const setProvider = useUiStore((s) => s.setProvider);

  const proceed = () => setStep("prompt");

  /**
   * Advance, pointing the run provider at what was just chosen.
   *
   * Every exit from this screen goes through here, because the choice made on it is the only
   * record of what the user wants — the next step reads the run provider to decide whether to
   * offer a free run of the shipped agent or a paid "describe an agent to build". Saving a key
   * used to advance without setting it, which left that decision resting on a default.
   */
  const proceedWith = (providerId: string) => {
    setProvider(providerId);
    proceed();
  };

  // The free path is a real configuration, not an absence of one: the run provider is set to
  // the dry-run model so the next screen is already pointed somewhere that works.
  const skip = () => proceedWith("fake");

  // The provider that is ALREADY connected, if any.
  //
  // Every other way off this screen goes through saving a key. That leaves out the person the
  // README tells to write runtime/.env by hand before ever opening the app: they arrive here,
  // see CONNECTED, and the only offers are "Try it free first" — which quietly points the next
  // screen at the dry-run provider — and re-typing a key they already have. Continuing with
  // what is already configured is the obvious answer and it was the one thing missing.
  const connected = providers.filter((p) => p.configured);
  const primary = connected.find((p) => p.powers_jaroku) ?? connected[0];

  // Same reasoning as skip(): point the next screen at something that works, which here is the
  // key the user already has rather than the dry-run model.
  const continueConnected = () => (primary ? proceedWith(primary.id) : proceed());

  return (
    <OnboardingSurface step="provider">
      <Reveal>
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          Connect a provider
        </h1>
        <p className="mt-2 text-[13.5px] leading-[1.6] text-muted">
          Jaroku runs on your own API keys — there is no Jaroku account, and nothing is proxied
          through us.
        </p>
      </Reveal>

      {/* The guarantee. Against a rule rather than in a box: it has to be read before the field
          below it, and it is not one of the things being chosen. The full version — env key
          name and all — lives inside the form itself, where the field it describes actually is. */}
      <Reveal delay={60}>
        <div className="mt-5 flex items-start gap-2.5 border-l border-hair pl-3">
          <span className="mt-[2px] shrink-0 text-ok">
            <ShieldCheckIcon size={ICON.sm} />
          </span>
          <p className="text-[12px] leading-[1.6] text-muted">
            A key you enter is written to <span className="font-mono text-ink">runtime/.env</span>{" "}
            on this machine — gitignored, read only by the Jaroku server process, never logged,
            never written into a generated project, and never sent back to this page.
          </p>
        </div>
      </Reveal>

      {/* One card per provider the Python runtime actually supports (jaroku_runner/models.py).
          `fake` is deliberately absent from this list: it is not something you connect, it is
          the third card below. */}
      <Reveal delay={120}>
        <div className={`${TYPE.sectionLabel} mt-7`}>Providers</div>
        <div className="mt-2 space-y-2">
          {!loaded && (
            <p className="text-[12px] text-faint">Checking which providers are connected…</p>
          )}
          {providers.map((p) => {
            const expanded = open === p.id;
            const brand = BRAND_COLOR[p.id];
            return (
              <ChoiceCard key={p.id} tint={p.configured ? brand : undefined}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : p.id)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 rounded-card px-3 py-3 text-left outline-none
                    transition-colors duration-fast hover:bg-active/30 focus-visible:shadow-focusring"
                >
                  {/* The mark, bare. It is a logo, and a logo in a bordered square is a
                      favicon — the box was doing the work the card around it already does.
                      icons.tsx's rule carries the state instead: full brand colour when the
                      provider is connected, grey when it is not, which is legible from across
                      the screen without reading a word of the card. */}
                  <span className="mt-[3px] shrink-0 self-start">
                    <ProviderMark provider={p.id} active={p.configured} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      {/* The name is ink, not brand-coloured. The tile beside it carries the
                          brand; a label that also wears it makes the provider's hue the loudest
                          thing on a screen whose actual state is "connected" or "not". */}
                      <span className="text-[13.5px] font-medium text-ink">
                        {PROVIDER_LABEL[p.id] ?? p.id}
                      </span>
                      {p.configured && (
                        <StatusBadge state="ok" variant="outline" label="connected" icon={KeyIcon} />
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-[1.5] text-muted">
                      {BLURB[p.id]}
                    </span>
                  </span>
                  {/* Two states, two shapes. "Add key" is an offer and reads as a control;
                      "replace key" is maintenance on something already done and recedes. */}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {p.configured ? (
                      <span className="hidden text-[11px] text-faint sm:inline">replace key</span>
                    ) : (
                      <span className="hidden items-center gap-1 rounded-control border border-edge px-2 py-1 text-[11px] text-muted sm:inline-flex">
                        <PlusIcon size={ICON.xs} />
                        Add key
                      </span>
                    )}
                    <span
                      className={`text-faint transition-transform duration-fast ${expanded ? "rotate-180" : ""}`}
                      aria-hidden
                    >
                      <ChevronDownIcon size={ICON.xs} />
                    </span>
                  </span>
                </button>

                {/* The one honest caveat the flow would otherwise hide until it bit somebody:
                    connecting OpenAI alone does not make Jaroku able to BUILD an agent, because
                    planning and generation are Anthropic-only (see the README's requirements). */}
                {!p.powers_jaroku && (
                  <p className="px-3 pb-3 text-[11px] leading-[1.55] text-faint">
                    Note: describing and generating agents goes through Anthropic. An OpenAI key
                    alone lets you run agents on GPT, not build them.
                  </p>
                )}
                {expanded && (
                  <div className="px-3 pb-3">
                    <ProviderKeyForm
                      provider={p}
                      onSaved={() => proceedWith(p.id)}
                      autoFocus
                      flush
                    />
                  </div>
                )}
              </ChoiceCard>
            );
          })}
        </div>
      </Reveal>

      {/* Continue on the key that is already there. Only once the snapshot has landed —
          before that, "nothing is configured" and "we have not been told yet" look the same,
          and a button that appears a beat late is worse than one that waits. */}
      {loaded && primary && (
        <Reveal delay={180}>
          <div className="mt-5">
            <PrimaryCta onClick={continueConnected} autoFocus kbd="↵">
              Continue with {PROVIDER_LABEL[primary.id] ?? primary.id}
            </PrimaryCta>
          </div>
        </Reveal>
      )}

      {/* The free path, as the third card rather than as a link under a rule.
          It is a real answer to the question this screen asks, so it is drawn as one — same box,
          same hover, same weight of action inside it. "or" between, because the two are
          alternatives and not a preference with an escape hatch. */}
      <Reveal delay={220}>
        <div className="mt-6 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-hair" />
          <span className={TYPE.panelLabel}>or</span>
          <span className="h-px flex-1 bg-hair" />
        </div>

        <div className="mt-4">
          <ChoiceCard>
            <div className="flex items-start gap-3 p-3">
              {/* Amber, and the same glyph the free run wears on the next screen — this is the
                  dry-run provider, and `run` is the colour of an agent executing. Bare, level
                  with the provider marks above it, because this card is one of the same three
                  choices and not a callout about them. */}
              <span className="mt-[3px] shrink-0 self-start text-run">
                <ZapIcon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[13.5px] font-medium text-ink">Try it free first</h2>
                <p className="mt-1 text-[12px] leading-[1.6] text-muted">
                  The dry-run provider costs nothing and is not a demo: it runs a real agent
                  through the real graph and emits a real trace, so the timeline, the state diffs
                  and the graph view all work exactly as they will with a paid key. Connect a
                  provider any time from Settings, or from the chip in the top bar.
                </p>
                <div className="mt-3">
                  <GhostCta onClick={skip} autoFocus={loaded && !primary}>
                    Explore with no key →
                  </GhostCta>
                </div>
              </div>
            </div>
          </ChoiceCard>
        </div>
      </Reveal>

      {/* A way back, because a step you cannot leave is a trap even when it is the right step. */}
      <Reveal delay={260}>
        <button
          type="button"
          className={`${quietBtn} mt-4 !px-0 !text-[11px]`}
          onClick={() => setStep("welcome")}
        >
          ← back
        </button>
      </Reveal>
    </OnboardingSurface>
  );
}

// Step 3 — the first prompt: one composer, alone, with a few real things to try.
//
// This wraps BuildPane rather than reimplementing it. BuildPane *is* the composer — the intent
// routing, the connector chips, the Chat/Test toggle, the plan and diff cards all live in it —
// and the only difference onboarding wants is what is mounted AROUND it. So the difference is
// exactly that: a narrower column, and a few examples in the pane's own empty slot. There is no
// forked composer and no second generation path.
//
// It stays mounted after onboarding ends, degrading to a bare BuildPane. That is deliberate:
// swapping the component out at completion would tear the composer down and rebuild it at the
// exact moment step 5 promises the user lands "in the exact state they were just in".
//
// THE EXAMPLES ARE DESCRIPTIONS, which route through the plan gate like any typed one. The first is
// the README's own, and matches the shipped fixtures, so replaying it stays free for testing.
//
// THERE IS NO FREE PATH ANY MORE. Without a key for planning this screen used to offer inputs for
// the bundled agent on the dry-run provider, and that provider is no longer offered. So the examples
// are the same either way; a send with no key opens Secrets at the provider it needs, and this screen
// says so up front rather than letting the first press be the surprise.

import { useEffect, useRef } from "react";
import { threadFor, useChatStore } from "../../store/chatStore.ts";
import { canBuild, useProviderStore } from "../../store/providerStore.ts";
import { useThreadStore } from "../../store/threadStore.ts";
import { useUiStore } from "../../store/uiStore.ts";
import { selectAgent } from "../../lib/selection.ts";
import { JarokuGlyph } from "../../lib/icons.tsx";
import { BRAND, ICON, SPACE_CLASS, TYPE } from "../../lib/tokens.ts";
import { BuildPane } from "../BuildPane.tsx";
import { ChevronRightIcon, SparklesIcon } from "../panelIcons.tsx";
import type { OnboardingPhase } from "./useOnboarding.ts";

/**
 * Descriptions, for the build path. Each is a real brief that produces a working agent.
 *
 * The first is the one the README uses and the one `fixtures/plan-support-bot.txt` +
 * `fixtures/support_bot.txt` were recorded against, so pointing the server at those fixtures
 * replays this exact click for free — which is what makes the whole flow testable without
 * spending anything.
 */
const DESCRIPTIONS = [
  {
    text: "A support agent that looks up order status in Postgres and drafts a reply",
    hint: "tick Postgres below",
  },
  {
    text: "An agent that answers questions about the current time in any timezone",
    hint: "no connectors needed",
  },
  {
    text: "An agent that reads a Slack channel and summarises what needs a reply",
    hint: "tick Slack below",
  },
];

/**
 * One example, as a row you can tell is a control before you touch it.
 *
 * These are the fastest path to a first agent and they were drawn as three identical bordered
 * strips that did nothing until clicked — the same shape a read-only list row has. Three things
 * fix that, and none of them is decoration:
 *
 *   * a leading glyph that says what the click DOES: it drafts the sentence into the composer for
 *     you to send, and nothing runs until you do
 *   * hover and focus carry weight — the border deepens, the text comes up to full ink, the
 *     surface fills. Same GLOW the provider cards use, so "you are on this one" looks identical
 *     wherever the app says it. It brightened the border under the near-black palette and deepens
 *     it under this one, which is the same sentence spoken by whichever end of the greyscale is
 *     free
 *   * a chevron that slides in on hover AND on keyboard focus. Reaching a row by Tab has to look
 *     exactly as arrived-at as reaching it with a pointer, or the keyboard path is second class
 */
function ExampleRow({
  text,
  hint,
  icon: Icon,
  title,
  onPick,
}: {
  text: string;
  hint: string;
  icon: (p: { size?: number }) => React.ReactElement;
  title: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={title}
      className="group flex w-full items-center gap-3 rounded-card border border-edge bg-panel/40 px-3 py-2.5
        text-left outline-none focus-visible:shadow-focusring transition-[background-color,box-shadow,color] duration-base ease-state
        hover:bg-panel hover:shadow-glow focus-visible:bg-panel focus-visible:shadow-focusring"
    >
      <span
        className="shrink-0 text-faint transition-colors duration-fast group-hover:text-ink group-focus-visible:text-ink"
        aria-hidden
      >
        <Icon size={ICON.sm} />
      </span>
      <span className="min-w-0 flex-1 text-label leading-[1.5] text-muted transition-colors duration-fast group-hover:text-ink group-focus-visible:text-ink">
        {text}
      </span>
      <span className="shrink-0 text-tiny text-faint">{hint}</span>
      <span
        className="shrink-0 -translate-x-1 text-faint opacity-0 transition-[transform,opacity,color] duration-base ease-state
          group-hover:translate-x-0 group-hover:opacity-100
          group-focus-visible:translate-x-0 group-focus-visible:opacity-100
          motion-reduce:transition-none"
        aria-hidden
      >
        <ChevronRightIcon size={ICON.xs} />
      </span>
    </button>
  );
}

/**
 * The heading block above the examples — and the one place on this screen the mark appears.
 *
 * It sits directly over the composer because that is what the screen is about: everything here
 * is a way of getting a sentence into the box below. Centred, while the examples under it stay
 * left-aligned — the heading is addressed to you, the examples are a list to scan.
 */
function BandHeading({
  icon: Icon,
  title,
  children,
}: {
  icon: (p: { size?: number }) => React.ReactElement;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-muted">
        <JarokuGlyph size={BRAND.screen} />
      </span>
      <h2 className="mt-3 flex items-center gap-2 text-page tracking-[-0.01em] text-ink">
        <span className="text-muted">
          <Icon size={ICON.md} />
        </span>
        {title}
      </h2>
      <p className="mt-2 max-w-[64ch] text-label leading-[1.6] text-muted">{children}</p>
    </div>
  );
}

export function ComposerColumn({ phase }: { phase: OnboardingPhase }) {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const threads = useChatStore((s) => s.threads);
  // The conversation is keyed by session, not by agent (§3.1) — see chatStore's header.
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const pending = useChatStore((s) => s.pending);

  // Only once the snapshot has landed: before that, "no key" and "not told yet" look identical, and
  // the note below would flash at somebody who has one.
  const needsKey = loaded && !canBuild(providers);

  // Nothing selected and the composer in Chat, once: that is what makes a typed description route
  // to `planAgent` through the composer's own intent rules.
  const aimed = useRef(false);
  useEffect(() => {
    if (phase !== "prompt" || aimed.current) return;
    aimed.current = true;
    selectAgent(null);
    useUiStore.getState().setComposerMode("chat");
  }, [phase]);

  // The examples are for an empty screen. Once there is a plan, a diff or a trace to read they
  // are just something else on the page — and BuildPane only renders this slot while the thread
  // is empty, so that happens on its own.
  const turns = threadFor({ threads, pending }, activeThreadId);
  const onboarding = phase === "prompt" || phase === "run";
  const showBand = phase === "prompt" && turns.length === 0;

  // Rendered into BuildPane's own empty slot rather than stacked above it: this REPLACES the
  // pane's "Describe the agent you want", which otherwise appeared twice — once at the top of
  // the column and once in the middle of it — with a gap between them.
  const band = (
    <>
      <BandHeading icon={SparklesIcon} title="Describe the agent you want">
        In plain English. You get a short plan first — its tools, state and graph — to approve or
        correct, and nothing is written until you do.
      </BandHeading>
      <div className={SPACE_CLASS.block}>
        <div className={TYPE.sectionLabel}>Try one of these</div>
        <div className="mt-2 space-y-1.5">
          {DESCRIPTIONS.map((e) => (
            <ExampleRow
              key={e.text}
              text={e.text}
              hint={e.hint}
              icon={SparklesIcon}
              title="Put this in the composer — you send it"
              // Fills the composer instead of sending, so the user reads what they are about to
              // ask for and sends it themselves — through the ordinary intent router, with
              // nothing spent on a mis-click.
              onPick={() => useUiStore.getState().prefillChat(e.text)}
            />
          ))}
        </div>
      </div>
      {/* SAID BEFORE THE FIRST PRESS rather than discovered by it. Somebody who skipped the key
          step can look at all of this; sending is where the key is asked for. */}
      {needsKey && (
        <p className="mt-4 text-center text-tiny leading-[1.6] text-faint">
          Planning and building go through Claude, and this workspace has no Claude key yet. Send one
          of these and Secrets opens where you can add it.
        </p>
      )}
    </>
  );

  return (
    // Narrowed to a reading column while onboarding, full width once the three columns are back.
    // The class changes; the element does not, so BuildPane is never remounted by it.
    <div className={`h-full ${onboarding ? "mx-auto w-full max-w-[760px]" : ""}`}>
      <BuildPane
        // Step 3 only. Once a plan or a run exists the app is arriving around this pane and it
        // goes back to being a column among columns — see BuildPane's `standalone`.
        standalone={phase === "prompt"}
        // No `h-full` wrapper any more: in standalone mode the pane centres the band and the
        // composer as one group, and a slot that insists on filling the height would push the
        // composer back down to the bottom edge it was just lifted off.
        emptySlot={showBand ? <div className="pb-6 pt-2">{band}</div> : undefined}
      />
    </div>
  );
}

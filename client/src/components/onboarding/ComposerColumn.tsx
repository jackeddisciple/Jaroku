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
// The examples branch on whether Jaroku can BUILD:
//
//   * With an Anthropic key — descriptions, which route through the plan gate like any typed
//     one. The first is the README's own, and matches the shipped fixtures, so the free replay
//     path stays available for repeatable testing.
//
//   * Without one — planning and generation are Anthropic-only, so a description would fail with
//     "ANTHROPIC_API_KEY is not set" as the first thing the product ever said. Instead this
//     offers inputs for the reference agent that ships in the repo, run on the free dry-run
//     provider: a real graph, a real trace, real depth, no cost. It is the README's own "Try it
//     in 60 seconds", and it reaches the same place — a live trace and a finished run — by the
//     only route that actually works with no key.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../../store/buildStore.ts";
import { threadFor, useChatStore } from "../../store/chatStore.ts";
import { canBuild, useProviderStore } from "../../store/providerStore.ts";
import { useThreadStore } from "../../store/threadStore.ts";
import { useTraceStore } from "../../store/traceStore.ts";
import { inputKey, useUiStore } from "../../store/uiStore.ts";
import { selectAgent } from "../../lib/selection.ts";
import { sendRun } from "../../lib/socket.ts";
import { JarokuGlyph } from "../../lib/icons.tsx";
import { BRAND, ICON, SPACE_CLASS, STATUS, TYPE } from "../../lib/tokens.ts";
import { BuildPane } from "../BuildPane.tsx";
import { ChevronRightIcon, PlayIcon, SparklesIcon, ZapIcon } from "../panelIcons.tsx";
import { EXAMPLE_AGENT_ID, type OnboardingPhase } from "./useOnboarding.ts";

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

/** Inputs for the shipped reference agent, for the free path. It has a clock and a calculator. */
const EXAMPLE_INPUTS = [
  { text: "What time is it in Europe/Paris?", hint: "one tool call" },
  { text: "What's 17 * 23, and what time is it in Tokyo?", hint: "two tools, one turn" },
];

/**
 * One example, as a row you can tell is a control before you touch it.
 *
 * These are the fastest path to a first agent and they were drawn as three identical bordered
 * strips that did nothing until clicked — the same shape a read-only list row has. Three things
 * fix that, and none of them is decoration:
 *
 *   * a leading glyph that says what the click DOES, which differs between the two paths. On the
 *     build path it drafts the sentence into the composer for you to send; on the free path it
 *     runs an agent immediately. Those are not the same promise and they should not wear the
 *     same mark
 *   * hover and focus lift by light — the border brightens, the text comes up to full ink, the
 *     surface fills. Same GLOW the provider cards use, so "you are on this one" looks identical
 *     wherever the app says it
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
      <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-muted transition-colors duration-fast group-hover:text-ink group-focus-visible:text-ink">
        {text}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{hint}</span>
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
  tone,
  title,
  children,
}: {
  icon: (p: { size?: number }) => React.ReactElement;
  /** Only for the free path, where amber means what it always means: something is going to run. */
  tone?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-muted">
        <JarokuGlyph size={BRAND.screen} />
      </span>
      <h2 className="mt-3 flex items-center gap-2 text-[19px] font-semibold tracking-[-0.01em] text-ink">
        <span style={tone ? { color: tone } : undefined} className={tone ? undefined : "text-muted"}>
          <Icon size={ICON.md} />
        </span>
        {title}
      </h2>
      <p className="mt-2 max-w-[64ch] text-[13px] leading-[1.6] text-muted">{children}</p>
    </div>
  );
}

export function ComposerColumn({ phase }: { phase: OnboardingPhase }) {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const agents = useBuildStore((s) => s.agents);
  const threads = useChatStore((s) => s.threads);
  // The conversation is keyed by session, not by agent (§3.1) — see chatStore's header.
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const pending = useChatStore((s) => s.pending);
  const connected = useTraceStore((s) => s.connection === "open");

  const exampleAgent = agents.find((a) => a.agent_id === EXAMPLE_AGENT_ID);
  // Only once the snapshot has landed: before that, "no key" and "not told yet" look identical,
  // and the free framing would flash at a user who has a key.
  //
  // The run provider is the second half of this, and it is the half that was missing. The free
  // path used to mean only "cannot build" — so a user WITH an Anthropic key who pressed "Try it
  // free first" was handed "Describe the agent you want", whose first action is a paid planning
  // call. The button said free and the screen behind it charged. The previous step records the
  // choice by setting the run provider, so read it: picking the dry-run provider IS choosing
  // the free path, whether or not a key happens to exist.
  const runProvider = useUiStore((s) => s.provider);
  const freePath = loaded && (!canBuild(providers) || runProvider === "fake");

  // Point the app at whatever the branch needs, once. The free path needs the reference agent
  // selected and the composer in Test mode (its input is the agent's input, not an instruction
  // to Jaroku); the build path needs nothing selected, which is what makes a typed description
  // route to `planAgent` through the composer's own intent rules.
  const aimed = useRef(false);
  useEffect(() => {
    if (phase !== "prompt" || !loaded || aimed.current) return;
    aimed.current = true;
    const ui = useUiStore.getState();
    if (freePath && exampleAgent) {
      selectAgent(EXAMPLE_AGENT_ID);
      ui.setComposerMode("test");
      ui.setProvider("fake");
    } else {
      selectAgent(null);
      ui.setComposerMode("chat");
    }
  }, [phase, loaded, freePath, exampleAgent]);

  // The examples are for an empty screen. Once there is a plan, a diff or a trace to read they
  // are just something else on the page — and BuildPane only renders this slot while the thread
  // is empty, so that happens on its own.
  const turns = threadFor({ threads, pending }, activeThreadId);
  const onboarding = phase === "prompt" || phase === "run";
  const showBand = phase === "prompt" && turns.length === 0;

  const runExample = (text: string) => {
    if (!connected) return;
    // Exactly what BuildPane's submit() does in Test mode: remember the input (so R re-runs it
    // and the eval promotion can reach it) and run. One run path, not a second one.
    localStorage.setItem(inputKey(EXAMPLE_AGENT_ID), text);
    sendRun(text, "fake", "fake-dry-run", EXAMPLE_AGENT_ID);
  };

  // Rendered into BuildPane's own empty slot rather than stacked above it: this REPLACES the
  // pane's "Describe the agent you want", which otherwise appeared twice — once at the top of
  // the column and once in the middle of it — with a gap between them.
  let band: React.ReactNode = null;
  if (freePath && exampleAgent) {
    band = (
      <>
        <BandHeading icon={ZapIcon} tone={STATUS.pending} title="Watch an agent think — free">
          This is the reference agent that ships with Jaroku, on the dry-run provider. Nothing is
          billed, and the trace is real: every LLM call, tool call and routing decision it makes
          streams in as it happens.
        </BandHeading>
        <div className={SPACE_CLASS.block}>
          <div className={TYPE.sectionLabel}>Run one of these</div>
          <div className="mt-2 space-y-1.5">
            {EXAMPLE_INPUTS.map((e) => (
              <ExampleRow
                key={e.text}
                text={e.text}
                hint={e.hint}
                // Play, not sparkles: this row RUNS the agent the moment it is clicked. The
                // build path's rows only draft a sentence, and two marks for two promises is
                // the least a row can do before it spends something on your behalf.
                icon={PlayIcon}
                title="Run the reference agent on this input — free, on the dry-run provider"
                onPick={() => runExample(e.text)}
              />
            ))}
          </div>
        </div>
        {/* Two audiences reach this screen now: someone with no key, and someone who has one
            and chose to look around first. Telling the second to go connect a key is telling
            them to do something they have already done. */}
        <p className="mt-4 text-center text-[11px] leading-[1.6] text-faint">
          {canBuild(providers)
            ? "Describing an agent of your own goes through Anthropic, which is already connected — build one whenever you are ready."
            : "Describing an agent of your own goes through Anthropic — add a key in the Secrets tab whenever you want to build one."}
        </p>
      </>
    );
  } else if (freePath) {
    // No key AND no shipped agent (deleted, or a partial checkout). Say so, rather than render a
    // screen whose buttons cannot work.
    band = (
      <BandHeading icon={SparklesIcon} title="Connect a provider to continue">
        Describing an agent goes through Anthropic, and the bundled example agent is not in{" "}
        <span className="font-mono">runtime/agents/</span>, so there is nothing to run for free.
        Add a key from Settings, or from the provider chip in the top bar.
      </BandHeading>
    );
  } else {
    band = (
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
      </>
    );
  }

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

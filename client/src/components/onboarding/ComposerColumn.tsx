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
import { useTraceStore } from "../../store/traceStore.ts";
import { inputKey, useUiStore } from "../../store/uiStore.ts";
import { sendRun } from "../../lib/socket.ts";
import { ICON } from "../../lib/tokens.ts";
import { BuildPane } from "../BuildPane.tsx";
import { SparklesIcon, ZapIcon } from "../panelIcons.tsx";
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

function ExampleButton({ text, hint, onPick }: { text: string; hint: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-baseline gap-3 rounded-card border border-edge px-3 py-2 text-left transition-colors hover:bg-active/40"
    >
      <span className="text-[13px] leading-[1.5] text-ink">{text}</span>
      <span className="ml-auto shrink-0 text-[11px] text-faint">{hint}</span>
    </button>
  );
}

export function ComposerColumn({ phase }: { phase: OnboardingPhase }) {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const threads = useChatStore((s) => s.threads);
  const pending = useChatStore((s) => s.pending);
  const connected = useTraceStore((s) => s.connection === "open");

  const exampleAgent = agents.find((a) => a.agent_id === EXAMPLE_AGENT_ID);
  // Only once the snapshot has landed: before that, "no key" and "not told yet" look identical,
  // and the free framing would flash at a user who has a key.
  const freePath = loaded && !canBuild(providers);

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
      useBuildStore.getState().selectAgent(EXAMPLE_AGENT_ID);
      ui.setComposerMode("test");
      ui.setProvider("fake");
    } else {
      useBuildStore.getState().selectAgent(null);
      ui.setComposerMode("chat");
    }
  }, [phase, loaded, freePath, exampleAgent]);

  // The examples are for an empty screen. Once there is a plan, a diff or a trace to read they
  // are just something else on the page — and BuildPane only renders this slot while the thread
  // is empty, so that happens on its own.
  const turns = threadFor({ threads, pending }, activeAgentId);
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
        <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <span className="text-run"><ZapIcon size={ICON.sm} /></span>
          Watch an agent think — free
        </h2>
        <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">
          This is the reference agent that ships with Jaroku, on the dry-run provider. Nothing is
          billed, and the trace is real: every LLM call, tool call and routing decision it makes
          streams in as it happens.
        </p>
        <div className="mt-3 space-y-1.5">
          {EXAMPLE_INPUTS.map((e) => (
            <ExampleButton key={e.text} text={e.text} hint={e.hint} onPick={() => runExample(e.text)} />
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-[1.6] text-faint">
          Describing an agent of your own goes through Anthropic — connect a key from Settings
          whenever you want to build one.
        </p>
      </>
    );
  } else if (freePath) {
    // No key AND no shipped agent (deleted, or a partial checkout). Say so, rather than render a
    // screen whose buttons cannot work.
    band = (
      <>
        <h2 className="text-[15px] font-medium text-ink">Connect a provider to continue</h2>
        <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">
          Describing an agent goes through Anthropic, and the bundled example agent is not in{" "}
          <span className="font-mono">runtime/agents/</span>, so there is nothing to run for free.
          Add a key from Settings, or from the provider chip in the top bar.
        </p>
      </>
    );
  } else {
    band = (
      <>
        <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <span className="text-muted"><SparklesIcon size={ICON.sm} /></span>
          Describe the agent you want
        </h2>
        <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">
          In plain English. You get a short plan first — its tools, state and graph — to approve or
          correct, and nothing is written until you do. Or start from one of these:
        </p>
        <div className="mt-3 space-y-1.5">
          {DESCRIPTIONS.map((e) => (
            <ExampleButton
              key={e.text}
              text={e.text}
              hint={e.hint}
              // Fills the composer instead of sending, so the user reads what they are about to
              // ask for and sends it themselves — through the ordinary intent router, with
              // nothing spent on a mis-click.
              onPick={() => useUiStore.getState().prefillChat(e.text)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    // Narrowed to a reading column while onboarding, full width once the three columns are back.
    // The class changes; the element does not, so BuildPane is never remounted by it.
    <div className={`h-full ${onboarding ? "mx-auto w-full max-w-[820px]" : ""}`}>
      <BuildPane
        emptySlot={showBand ? <div className="flex h-full flex-col justify-center">{band}</div> : undefined}
      />
    </div>
  );
}

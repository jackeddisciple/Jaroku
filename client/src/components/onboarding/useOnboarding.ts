// The first-run state machine.
//
// Five states, and every transition is derived from state that already exists — a plan turn in
// chatStore, a file streaming into buildStore, a run ending in traceStore. Nothing here
// listens to the socket directly and nothing here is a second source of truth; onboarding is a
// reading of the app's own progress, not a parallel record of it.
//
// Two transitions are the user's (Get started, and connect-or-skip) and are made by the steps
// themselves calling `setOnboardingStep`. The other two are the app's, and are made here.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../../store/buildStore.ts";
import { useChatStore } from "../../store/chatStore.ts";
import { useTraceStore } from "../../store/traceStore.ts";
import { hasOnboardingRecord, useUiStore } from "../../store/uiStore.ts";

/** The four onboarding views, plus the one that means "the normal app". */
export type OnboardingPhase = "welcome" | "provider" | "prompt" | "run" | "complete";

/**
 * The reference agent that ships in the repo, and the only one a fresh clone has.
 *
 * It does double duty: it is the free path's subject (see FirstPromptStep), and its presence
 * is what makes "has this instance ever been used?" answerable below.
 */
export const EXAMPLE_AGENT_ID = "example_agent";

/**
 * Whether anything was stored BEFORE this session started.
 *
 * Read once at module load rather than at call time, because the first thing the flow does is
 * write — after that, `hasOnboardingRecord()` is true for reasons that say nothing about
 * whether the user had been here before.
 */
const HAD_RECORD_AT_LOAD = hasOnboardingRecord();

export interface Onboarding {
  phase: OnboardingPhase;
  /** Step 4's progressive reveal: the left column, then the right one. */
  mountSidebar: boolean;
  mountRightPanel: boolean;
}

export function useOnboarding(): Onboarding {
  const complete = useUiStore((s) => s.onboardingComplete);
  const step = useUiStore((s) => s.onboardingStep);

  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const genStatus = useBuildStore((s) => s.status);
  const genFileCount = useBuildStore((s) => s.fileOrder.length);
  const pending = useChatStore((s) => s.pending);
  const threads = useChatStore((s) => s.threads);
  const runs = useTraceStore((s) => s.runs);

  // --- an instance that has clearly been used before ------------------------------------
  //
  // Onboarding is gated on a browser-local flag, so an existing user upgrading into this build
  // has no flag and would be met by a Welcome screen for a product they already use.
  //
  // A generated agent is the signal, because it is the one thing that cannot be there by
  // accident: a fresh clone ships `example_agent` and nothing else (.gitignore keeps
  // `runtime/agents/*` out except that one), and the boot autorun creates a run without
  // creating an agent. So "an agent that is not the shipped one exists" means somebody built
  // something here.
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || complete || HAD_RECORD_AT_LOAD) return;
    if (agents.length === 0) return; // the snapshot has not landed yet
    if (agents.some((a) => a.agent_id !== EXAMPLE_AGENT_ID)) {
      settled.current = true;
      useUiStore.getState().completeOnboarding();
    }
  }, [agents, complete]);

  // --- step 3 → 4: the first thing the app does back ---------------------------------------
  //
  // Either a plan card appeared (the build path — the plan gate is the only way into
  // generation, so this is the first response to a described agent), or a run started (the
  // free path, where the user is testing the shipped agent and there is no plan to wait for).
  const planOnScreen = pending.some((t) => t.role === "jaroku" && t.kind === "plan");
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const runStarted = Boolean(activeRunId && runs[activeRunId]?.agent_id === activeAgentId);
  useEffect(() => {
    if (complete || step !== "prompt") return;
    if (planOnScreen || runStarted) useUiStore.getState().setOnboardingStep("run");
  }, [complete, step, planOnScreen, runStarted]);

  // --- step 4 → 5: the loop closed ---------------------------------------------------------
  //
  // A finished run for the agent the user is working on. Deliberately matched on `agent_id`
  // rather than "any run_end": the server fires one run of the fixture agent 300ms after boot
  // (server/src/index.ts, JAROKU_NO_AUTORUN), and a rule that counted that would complete
  // onboarding before the user had done anything at all.
  //
  // An error counts. A run that failed still emitted a trace, still showed every decision the
  // agent made, and is a legitimate "the loop worked" — pretending otherwise would trap
  // somebody whose first agent has a bug in an onboarding flow they cannot leave.
  const finishedOwnRun =
    Boolean(activeAgentId) &&
    Object.values(runs).some((r) => r.agent_id === activeAgentId && r.ended_at !== null);
  useEffect(() => {
    if (complete || step !== "run" || !finishedOwnRun) return;
    useUiStore.getState().completeOnboarding();
  }, [complete, step, finishedOwnRun]);

  const phase: OnboardingPhase = complete ? "complete" : step;

  // --- the reveal ---------------------------------------------------------------------------
  //
  // The right panel waits for something to put in it. An empty Graph/Trace/Evals/MCP tab bar
  // beside a composer reads as broken rather than as a feature not yet reached, so it arrives
  // when files start streaming (or, on the free path, when a run does) — and after a reload
  // mid-flow, whenever the agent it would describe already exists.
  const agentHasThread = Boolean(activeAgentId && (threads[activeAgentId]?.length ?? 0) > 0);
  const mountRightPanel =
    phase === "complete" ||
    (phase === "run" &&
      (genStatus === "generating" || genFileCount > 0 || runStarted || agentHasThread || finishedOwnRun));

  return {
    phase,
    mountSidebar: phase === "run" || phase === "complete",
    mountRightPanel,
  };
}

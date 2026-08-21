// §5.1 step 4 — starting the first agent, through the paths that already exist.
//
// NEITHER BRANCH IS A NEW MECHANISM, and that is the whole design. §5.1 says the described path
// "kicks off the normal agent generation flow — with the plan gate shown as a normal turn. The user
// sees their first plan card as part of onboarding, which is the 'wow' moment." A special
// onboarding generator would be a second code path producing agents, and the first thing it would
// diverge on is the plan gate — which is precisely the thing worth seeing.
//
// SO THIS FILE IS TWO CALLS AND A COMMENT ABOUT WHY. The sample branch selects the agent that
// already ships; the described branch sends a message down the composer's own channel. Everything
// after that — the plan card, the streaming files, the panels arriving — is the app, working the
// way it works on day two.
//
// IT RESOLVES WHEN THE WORK HAS *STARTED*, NEVER WHEN IT HAS FINISHED. Generation takes tens of
// seconds and ends in a plan card somebody has to answer; a promise that waited for that would be a
// promise that never settles when they close the window, and a step 4 that could not be left. The
// screen advances to step 5 and the generation continues behind it, which is where the progressive
// reveal picks it up.

import { EXAMPLE_AGENT_ID } from "../components/onboarding/useOnboarding.ts";
import { sendPlanAgent } from "./socket.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";

export type FirstAgentChoice =
  /** §5.1's default: the two-tool agent that ships, and runs with no provider key at all. */
  | { kind: "sample" }
  /** The normal generation flow, on its first turn. */
  | { kind: "describe"; prompt: string };

export async function startFirstAgent(choice: FirstAgentChoice): Promise<void> {
  if (choice.kind === "sample") {
    // THE ONE THAT WORKS FOR EVERYBODY. §5.1 makes it the default explicitly because it "runs
    // offline (dry-run) with no API key" — which is what keeps step 3's skip honest. Selecting it
    // is all this does: it is already on disk in a fresh clone, so there is nothing to generate and
    // nothing that can fail.
    const agents = useBuildStore.getState().agents;
    const sample = agents.find((a) => a.agent_id === EXAMPLE_AGENT_ID) ?? agents[0];
    if (!sample) {
      // A workspace with no agents at all and no sample to select. Rare — a fresh clone ships one —
      // and the honest outcome is to say so rather than to advance into an app with nothing in it
      // and no explanation.
      throw new Error("there is no sample agent in this workspace yet — try again in a moment");
    }
    useBuildStore.getState().selectAgent(sample.agent_id);
    // The reveal starts here rather than at the end: the sidebar and right panel arrive as the app
    // has something to put in them, which is what `useOnboarding` already watches for.
    useUiStore.getState().setOnboardingStep("run");
    return;
  }

  const prompt = choice.prompt.trim();
  if (!prompt) throw new Error("describe the agent you want");
  // THE PLAN GATE, ASKED FOR BY NAME. `sendPlanAgent` is the composer's own first move — the gate
  // is the only way into generation — so what appears is a real plan card on a real turn, which is
  // exactly what §5.1 calls the "wow" moment. Going straight to `sendGenerate` would skip it and
  // hand somebody a finished agent they never saw being decided.
  //
  // NO CONNECTORS AND NO MCP TOOLS. A first agent is described in one sentence by somebody who has
  // not seen the connectors panel yet; offering none is the honest starting point, and everything
  // after this turn is the ordinary product where they can add some.
  sendPlanAgent(prompt, []);
  useUiStore.getState().setOnboardingStep("run");
}

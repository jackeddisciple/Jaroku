// §5.1 step 4 — starting the first agent, through the paths that already exist.
//
// NEITHER BRANCH IS A NEW MECHANISM, and that is the whole design. §5.1 says the described path
// "kicks off the normal agent generation flow — with the plan gate shown as a normal turn. The user
// sees their first plan card as part of onboarding, which is the 'wow' moment." A special
// onboarding generator would be a second code path producing agents, and the first thing it would
// diverge on is the plan gate — which is precisely the thing worth seeing.
//
// SO THIS FILE IS TWO CALLS, A GUARD, AND THE REASONS FOR EACH. The sample branch selects the agent
// that already ships; the described branch asks for a plan on the composer's own channel.
// Everything after that — the plan card, the streaming files, the panels arriving — is the app,
// working the way it works on day two.
//
// THE GUARD IS THE PART WORTH READING. Step 4's button advances to "You're all set" the moment this
// resolves, so anything that fails silently here produces a flow that congratulates somebody and
// leaves them with an empty app and no way to tell why. Two things can fail that way and both are
// checked: a socket that is not open — `send` returns false and every other caller in `socket.ts`
// legitimately ignores it, because they are composers inside a connected app where a dropped frame
// is a reconnect the user can already see — and a workspace with no sample agent in it.
//
// AND IT RESOLVES WHEN THE WORK HAS *STARTED*, NEVER WHEN IT HAS FINISHED. Generation takes tens of
// seconds and ends in a plan card somebody has to answer; a promise that waited for that would be a
// promise that never settles when they close the window, and a step 4 that could not be left. The
// screen advances to step 5 and the generation continues behind it, which is where the progressive
// reveal picks it up.

import { EXAMPLE_AGENT_ID } from "../components/onboarding/useOnboarding.ts";
import { sendPlanAgent } from "./socket.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";

export type FirstAgentChoice =
  /** §5.1's default: the two-tool agent that ships, and runs with no provider key at all. */
  | { kind: "sample" }
  /** The normal generation flow, on its first turn. */
  | { kind: "describe"; prompt: string };

/**
 * The message a closed socket produces.
 *
 * NAMED, so the screen and the suite say the same thing. It describes what is true — the backend is
 * not reachable right now — rather than what somebody should do, because there is nothing to do but
 * wait a moment, and "try again" on a screen with a Skip beside it reads as an instruction to keep
 * pressing a button.
 */
export const NOT_CONNECTED = "Jaroku isn't connected to its backend yet — give it a moment, or skip this step.";

/**
 * What starting an agent needs from the rest of the app.
 *
 * SUPPLIED RATHER THAN REACHED FOR, which is the idiom every dependency in the server half of this
 * codebase follows and is here for the same reason: it makes the rule testable without standing up
 * the thing it acts on. `socket.ts` holds its WebSocket in a module-level binding with no setter,
 * so the alternative was a test-only export on production code — a hook that exists for no reason
 * except that somebody could not otherwise reach past it.
 *
 * Every field defaults to the real thing, so the one production call site passes nothing.
 */
export interface FirstAgentDeps {
  /** Whether the backend is reachable right now. */
  connected: () => boolean;
  /** The agents this workspace has, for the sample branch to choose from. */
  agents: () => { agent_id: string }[];
  select: (agentId: string) => void;
  /** Ask for a plan. Returns whether the frame actually went — see the header. */
  planAgent: (prompt: string) => boolean;
  /** Move the progressive reveal along. */
  reveal: () => void;
}

const REAL: FirstAgentDeps = {
  connected: () => useTraceStore.getState().connection === "open",
  agents: () => useBuildStore.getState().agents,
  select: (agentId) => useBuildStore.getState().selectAgent(agentId),
  planAgent: (prompt) => sendPlanAgent(prompt, []),
  reveal: () => useUiStore.getState().setOnboardingStep("run"),
};

export async function startFirstAgent(
  choice: FirstAgentChoice,
  deps: FirstAgentDeps = REAL,
): Promise<void> {
  // BEFORE EITHER BRANCH, because both need the socket and neither can tell afterwards. The sample
  // branch selects an agent locally and then relies on the app fetching its files over the socket;
  // the described branch sends a frame. A closed socket makes the first one look like it worked and
  // the second one do nothing at all.
  if (!deps.connected()) throw new Error(NOT_CONNECTED);

  if (choice.kind === "sample") {
    // THE ONE THAT WORKS FOR EVERYBODY. §5.1 makes it the default explicitly because it "runs
    // offline (dry-run) with no API key" — which is what keeps step 3's skip honest. Selecting it
    // is all this does: it is already on disk in a fresh clone, so there is nothing to generate and
    // nothing that can fail.
    //
    // AND IT IS NOT RUN HERE. §5.1's step 5 lists "Run your agent to see it work" as the first
    // thing to try next, which is a suggestion rather than something already done — an onboarding
    // that ran it for them would take away the moment it is pointing at.
    const agents = deps.agents();
    const sample = agents.find((a) => a.agent_id === EXAMPLE_AGENT_ID) ?? agents[0];
    if (!sample) {
      // A workspace with no agents at all and no sample to select. Rare — a fresh clone ships one —
      // and the honest outcome is to say so rather than to advance into an app with nothing in it
      // and no explanation. §5.1's own skip is right there for anybody who hits this.
      throw new Error("There's no sample agent in this workspace yet — try again in a moment, or skip this step.");
    }
    deps.select(sample.agent_id);
    // The reveal starts here rather than at the end: the sidebar and right panel arrive as the app
    // has something to put in them, which is what `useOnboarding` already watches for.
    deps.reveal();
    return;
  }

  const prompt = choice.prompt.trim();
  if (!prompt) throw new Error("Describe the agent you want.");
  // THE PLAN GATE, ASKED FOR BY NAME. `sendPlanAgent` is the composer's own first move — the gate is
  // the only way into generation — so what appears is a real plan card on a real turn, which is
  // exactly what §5.1 calls the "wow" moment. Going straight to `sendGenerate` would skip it and
  // hand somebody a finished agent they never saw being decided.
  //
  // NO CONNECTORS AND NO MCP TOOLS. A first agent is described in one sentence by somebody who has
  // not seen the connectors panel yet; offering none is the honest starting point, and everything
  // after this turn is the ordinary product where they can add some.
  const sent = deps.planAgent(prompt);
  // See the header. This is the one `send` in the client whose false is acted on.
  if (!sent) throw new Error(NOT_CONNECTED);
  deps.reveal();
}

// §5.1 step 4, and the failure it is one line away from having.
//
// THE BUTTON ON THAT SCREEN ADVANCES TO "YOU'RE ALL SET" THE MOMENT `startFirstAgent` RESOLVES.
// So anything that fails quietly here produces a flow that congratulates somebody and leaves them
// with an empty app and no way to tell why — which is worse than an error, because there is nothing
// on screen to report. Three things can fail that way and this suite is mostly about all three:
//
//   A CLOSED SOCKET. `send` in `socket.ts` returns false when the connection is not open, and every
//   other caller in that file legitimately ignores it — they are composers inside a connected app,
//   where a dropped frame is a reconnect the user can already see. This caller cannot: it is on a
//   screen with no reconnect indicator on it that is about to navigate away. `sendPlanAgent` is the
//   one sender in the client that returns whether it sent, and this is why.
//
//   A SOCKET THAT LOOKED OPEN AND WAS NOT. The store says connected; the frame still does not go.
//   Both are checked, because they fail at different moments and only one of them is a state a
//   component could have rendered around.
//
//   A WORKSPACE WITH NO SAMPLE AGENT. The sample branch SELECTS rather than generates, so with
//   nothing to select it would advance having done nothing at all.
//
// AND THE ASSERTION ABOUT WHICH COMMAND IS SENT IS NOT A DETAIL. §5.1 wants the plan gate — "the
// user sees their first plan card as part of onboarding, which is the 'wow' moment" — so this asks
// for a PLAN and not a generate. A `generate` would work, produce an agent, and skip the one moment
// the step exists for.
//
//   npm run test:first-agent

import { NOT_CONNECTED, startFirstAgent, type FirstAgentDeps } from "./firstAgent.ts";
import { EXAMPLE_AGENT_ID } from "../components/onboarding/useOnboarding.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

/** What the app was asked to do, and what it was told. */
interface Recorder {
  deps: FirstAgentDeps;
  selected: string[];
  planned: string[];
  revealed: number;
}

function recorder(over: Partial<{ connected: boolean; agents: string[]; planSucceeds: boolean }> = {}): Recorder {
  const selected: string[] = [];
  const planned: string[] = [];
  const state = { revealed: 0 };
  const rec: Recorder = {
    selected,
    planned,
    get revealed(): number {
      return state.revealed;
    },
    deps: {
      connected: () => over.connected ?? true,
      agents: () => (over.agents ?? []).map((agent_id) => ({ agent_id })),
      select: (id) => void selected.push(id),
      planAgent: (prompt) => {
        planned.push(prompt);
        return over.planSucceeds ?? true;
      },
      reveal: () => void (state.revealed += 1),
    },
  };
  return rec;
}

async function refused(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("\nthe sample, which is §5.1's default because it works for everybody");
{
  const r = recorder({ agents: ["something_else", EXAMPLE_AGENT_ID] });
  await startFirstAgent({ kind: "sample" }, r.deps);

  // THE SHIPPED ONE BY NAME, not "the first agent in the list". A workspace that already has agents
  // in it — somebody restarting the tour from settings — would otherwise have the sample step
  // select whichever happened to sort first.
  check("the shipped sample is the one selected", r.selected.join(",") === EXAMPLE_AGENT_ID);
  // §5.1's step 5 lists "Run your agent to see it work" as the first thing to TRY NEXT. Running it
  // here would take away the moment the next screen is pointing at.
  check("nothing is generated — the sample is selected, not built", r.planned.length === 0);
  // The reveal starts here rather than at the end: the sidebar and right panel arrive as the app
  // has something to put in them.
  check("the progressive reveal is moved along", r.revealed === 1);
}
{
  // A workspace whose sample is missing but which has something else. Selecting anything is better
  // than advancing into an app with nothing in it.
  const r = recorder({ agents: ["only_one"] });
  await startFirstAgent({ kind: "sample" }, r.deps);
  check("with no shipped sample, the agent that IS there is selected", r.selected.join(",") === "only_one");
}
{
  // AND WITH NOTHING AT ALL IT REFUSES. Advancing here would congratulate somebody and leave them
  // with an empty app — the failure this whole suite is about.
  const r = recorder({ agents: [] });
  const message = await refused(() => startFirstAgent({ kind: "sample" }, r.deps));
  check("a workspace with no agents at all refuses rather than advancing", message !== null);
  check("...saying so in a sentence that points at the skip", (message ?? "").includes("skip"));
  check("...and the reveal was not moved", r.revealed === 0);
  check("...and nothing was selected", r.selected.length === 0);
}

console.log("\ndescribing your own, which is the plan gate on its first turn");
{
  const r = recorder();
  await startFirstAgent({ kind: "describe", prompt: "  an agent that reads my calendar  " }, r.deps);

  // §5.1: "kicks off the normal agent generation flow — with the plan gate shown as a normal turn."
  // A `generate` would work, produce an agent, and skip the one moment the step exists for. That
  // this calls `planAgent` rather than anything else is the assertion; `test:desktop-contract` has
  // no view of it and neither does the typechecker.
  check("one plan is asked for", r.planned.length === 1);
  check("...with the description, trimmed", r.planned[0] === "an agent that reads my calendar");
  check("...and no agent is selected, because none exists yet", r.selected.length === 0);
  check("the progressive reveal is moved along", r.revealed === 1);
}
{
  const r = recorder();
  const message = await refused(() => startFirstAgent({ kind: "describe", prompt: "   " }, r.deps));
  check("an empty description refuses", message !== null);
  check("...and asks for nothing", r.planned.length === 0);
  check("...and does not move the reveal", r.revealed === 0);
}

console.log("\nwhat a closed socket does, which is the failure worth having a suite for");
{
  const r = recorder({ connected: false, agents: [EXAMPLE_AGENT_ID] });
  const sample = await refused(() => startFirstAgent({ kind: "sample" }, r.deps));
  check("the sample branch refuses when the backend is not reachable", sample === NOT_CONNECTED);
  check("...and selects nothing", r.selected.length === 0);
  check("...and does not move the reveal", r.revealed === 0);

  const described = await refused(() => startFirstAgent({ kind: "describe", prompt: "anything" }, r.deps));
  check("the describe branch refuses too", described === NOT_CONNECTED);
  check("...having asked for nothing", r.planned.length === 0);
}
{
  // THE NARROWER CASE, and the reason `sendPlanAgent` returns a boolean at all: the store says
  // connected and the socket has since gone. `send` returns false, every other caller in
  // `socket.ts` ignores that, and this one must not.
  const r = recorder({ connected: true, planSucceeds: false });
  const message = await refused(() => startFirstAgent({ kind: "describe", prompt: "anything" }, r.deps));
  check("a frame that could not be put on the wire is a refusal, not a silent success", message === NOT_CONNECTED);
  check("...and the reveal was not moved", r.revealed === 0);
  // It was ATTEMPTED, which is the difference between this case and the one above it: the guard let
  // it through and the send is what failed.
  check("...though the attempt was made, unlike the guarded case", r.planned.length === 1);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

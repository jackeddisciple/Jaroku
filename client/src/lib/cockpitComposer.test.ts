// §24's `test:cockpit-composer`: "the situation function's precedence, a fixture per state, and
// `null` status when nothing is happening".
//
// PRECEDENCE IS THE PROPERTY AND A FIXTURE PER STATE IS NOT ENOUGH TO SEE IT. Six fixtures, each
// with exactly one thing wrong, pass against any ordering of the branches — including one that
// tells a reader with no permission to pick an agent first, which is a path ending in the same
// refusal they were not told about. So every case here sets SEVERAL things wrong at once and
// asserts which one is spoken.
//
// AND THE `null` STATUS, WHICH §23 REPEATS AND WHICH IS THE EASIEST CLAUSE TO LOSE: "the status
// says what the app is doing and is null when the answer is nothing. A composer that reports 'idle'
// is noise." It is easy to lose because a status of `"Ready"` looks like more information than an
// empty line, and it is not — it is a line of chrome that never changes, under an input whose
// emptiness already says the same thing.
//
//   npm run test:cockpit-composer

import { COMPOSER } from "./cockpitCopy.ts";
import { cockpitComposer, type CockpitSituation } from "./cockpitComposer.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Ready: one live agent, connected, free, permitted, nothing in flight, under the cap. */
const situation = (patch: Partial<CockpitSituation> = {}): CockpitSituation => ({
  liveAgents: 1,
  agentName: "billing_bot",
  connected: true,
  atCapacity: false,
  permitted: true,
  inFlight: false,
  overCap: false,
  ...patch,
});

// --- 1. ready says nothing about itself -----------------------------------------------------------

console.log("\na composer that reports idle is noise");
{
  const ready = cockpitComposer(situation());
  check("the status is null when nothing is happening", ready.status === null, String(ready.status));
  check("...and the control can be pressed", ready.ready);
  check("the placeholder names the agent", ready.placeholder.includes("billing_bot"), ready.placeholder);
  check("...and says what to type rather than what is wrong",
    !/cannot|not connected|capacity/i.test(ready.placeholder), ready.placeholder);
}

// --- 2. every state produces its own sentence -----------------------------------------------------

console.log("\na fixture per state");
{
  const states: [string, CockpitSituation][] = [
    ["ready", situation()],
    ["no agent", situation({ agentName: null })],
    ["nothing deployed", situation({ liveAgents: 0, agentName: null })],
    ["not connected", situation({ connected: false })],
    ["at capacity", situation({ atCapacity: true })],
    ["not permitted", situation({ permitted: false })],
    ["in flight", situation({ inFlight: true })],
  ];

  for (const [name, s] of states) {
    const moment = cockpitComposer(s);
    check(`${name} has a placeholder`, moment.placeholder.length > 0, moment.placeholder);
  }

  // EVERY REFUSAL REFUSES. The one thing all six of the non-ready states must agree on.
  for (const [name, s] of states.slice(1)) {
    check(`${name} cannot be dispatched`, !cockpitComposer(s).ready, name);
  }

  // AND THE FOUR THAT ARE ABOUT SOMETHING HAPPENING SAY WHAT. `no agent` is deliberately silent —
  // "Pick an agent first" is already the whole of it, and a status repeating it would be the
  // composer telling the reader the same thing twice, six pixels apart.
  for (const name of ["not connected", "at capacity", "not permitted", "in flight"]) {
    const s = states.find(([n]) => n === name)![1];
    check(`${name} says what the app is doing`, cockpitComposer(s).status !== null, name);
  }
  check("no agent stays silent", cockpitComposer(situation({ agentName: null })).status === null);
  check("...and so does nothing deployed",
    cockpitComposer(situation({ liveAgents: 0, agentName: null })).status === null);

  // SEVEN STATES, AND NO TWO OF THEM READ THE SAME. A composer whose "not connected" and "at
  // capacity" said the same thing would have thrown away the distinction the states exist for.
  const spoken = states.map(([, s]) => {
    const m = cockpitComposer(s);
    return `${m.placeholder}|${m.status ?? ""}`;
  });
  // `no agent` and `nothing deployed` legitimately coincide: from the composer's point of view
  // there is nothing to send to, and the difference between them is answered by the EMPTY STATE
  // above the list rather than by the input. Six distinct readings out of seven states.
  check(`the states read as six different composers (${new Set(spoken).size})`,
    new Set(spoken).size === 6, spoken.join("  //  "));
}

// --- 3. the precedence, which a fixture per state cannot see ---------------------------------------

console.log("\nwhich one is spoken when several are true");
{
  // 1. IN FLIGHT OUTRANKS EVERYTHING. `composerMoment`'s own second rule: what the app is doing
  // outranks what you could ask it to do — and a second press while the first is unacknowledged is
  // the commonest way one job gets sent twice.
  const busyAndBroken = cockpitComposer(situation({
    inFlight: true, connected: false, atCapacity: true, permitted: false, agentName: null,
  }));
  check("a dispatch in flight is what gets said", busyAndBroken.status === COMPOSER.status.inFlight,
    String(busyAndBroken.status));

  // 2. PERMISSION OUTRANKS EVERY CHOICE ON THE SCREEN, because no choice changes it. A reader told
  // to pick an agent first is being sent down a path that ends in the same refusal.
  const forbidden = cockpitComposer(situation({
    permitted: false, agentName: null, connected: false, atCapacity: true,
  }));
  check("permission outranks having no agent", forbidden.status === COMPOSER.status.forbidden,
    String(forbidden.status));
  check("...and names the capability in human words", /run:execute|capability/.test(forbidden.status ?? ""),
    String(forbidden.status));

  // 3. NO DESTINATION OUTRANKS ANYTHING WRONG WITH A DESTINATION, which is the rung that is easy to
  // put in the wrong place: a function checking `connected` first would report "not connected"
  // about an agent nobody has chosen.
  const nothingChosen = cockpitComposer(situation({ agentName: null, connected: false, atCapacity: true }));
  check("having no agent outranks that agent's state",
    nothingChosen.placeholder === COMPOSER.placeholder.noAgent, nothingChosen.placeholder);

  // 4. REACHABILITY OUTRANKS CAPACITY, because an unreachable agent's capacity is not a fact
  // anybody has checked — the container has not answered.
  const unreachableAndBusy = cockpitComposer(situation({ connected: false, atCapacity: true }));
  check("not connected outranks at capacity",
    unreachableAndBusy.status === COMPOSER.status.unconnected, String(unreachableAndBusy.status));

  // 6. THE CAP IS LAST, because it is the only refusal the reader can fix by editing what is in
  // front of them — and §19 requires it caught here rather than after the gate.
  const overAndBusy = cockpitComposer(situation({ overCap: true, atCapacity: true }));
  check("at capacity outranks an over-long input",
    overAndBusy.status === COMPOSER.status.busy, String(overAndBusy.status));
}

// --- 4. the byte cap refuses without rewriting an invisible string ---------------------------------

console.log("\na refusal in a string nobody can see");
{
  const over = cockpitComposer(situation({ overCap: true }));
  check("an over-long input cannot be dispatched", !over.ready);
  // A PLACEHOLDER IS ONLY VISIBLE IN AN EMPTY FIELD, and a field over the byte cap is by definition
  // not empty — so a branch that wrote a refusal into the placeholder would be the one branch of
  // this function that never renders. The reason belongs on the disabled control instead.
  check("...and the placeholder is still the ready one",
    over.placeholder === COMPOSER.placeholder.ready("billing_bot"), over.placeholder);
  check("...with no status invented for it", over.status === null, String(over.status));
}

// --- 5. §19's own requirement: the refusals are knowable before the gate ---------------------------

console.log("\nnothing that was always going to be refused reaches a confirmation");
{
  // §19: "No live deployment, no stored token, over the input cap: all of these are known
  // client-side or on the first server hop, and asking the user to confirm something that was
  // always going to be refused is the worst version of this flow." Which in this function means:
  // each of the three answers `ready: false`, so the gate is never opened for them.
  for (const [name, s] of [
    ["no live deployment", situation({ liveAgents: 0, agentName: null })],
    ["no stored token", situation({ connected: false })],
    ["over the cap", situation({ overCap: true })],
  ] as [string, CockpitSituation][]) {
    check(`${name} is refused before the gate`, !cockpitComposer(s).ready, name);
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

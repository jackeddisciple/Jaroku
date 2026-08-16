// Aligning two traces, and the sweep policy that reclaims what a shadow run left behind.
//
// THE CASE THIS SUITE EXISTS FOR is §B.2.3's own mock: one side retries a tool and the other does
// not, so every step after the retry is offset by one. A comparison keyed on sequence number
// reports that as three changed steps and one added; the honest reading is ONE added step and
// nothing else moved. That difference is the whole value of the surface — somebody is looking at
// two refs to find out what changed, and a diff that reports four differences where there is one
// has answered a question they did not ask.
//
// AND THE NUMBERS, which are the other half: cost and latency are compared with null as its own
// value, because an unpriced step is not a free one. A footer that summed the priced half and
// printed it would be an exact-looking floor.
//
//   npm run test:trace-diff

import { diffTraces, identityOf } from "./traceDiff.ts";
import { SWEEP_AFTER_MS, shadowStagingId, shouldSweep, type ShadowRun } from "./shadowRuns.ts";
import type { Step } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

let seq = 0;
function step(patch: Partial<Step> & Pick<Step, "type" | "name">): Step {
  seq += 1;
  return {
    id: `step-${seq}`,
    run_id: "run-1",
    seq,
    input: null,
    output: null,
    state_before: null,
    state_after: null,
    tokens: null,
    cost: null,
    latency_ms: 0,
    error: null,
    parent_step_id: null,
    started_at: new Date(seq * 1000).toISOString(),
    ...patch,
  };
}

const shape = (rows: { change: string }[]): string => rows.map((r) => r.change).join(",");

console.log("\nwhat counts as the same step");
{
  check(identityOf({ type: "tool_call", name: "get_weather" }) === "tool_call\u0000get_weather",
    "type and name, which is what survives a different answer");
  // A step's name is a tool name a model chose, so any printable separator is a character that
  // could appear inside one — `llm_call` + `a b` and `llm_call a` + `b` must not collide.
  // The type is a closed set, so the collision has to be constructed on the NAME side: a NUL
  // cannot appear in a tool name, and a printable separator could.
  check(identityOf({ type: "llm_call", name: "a b" }).includes("\u0000"),
    "and a NUL separates them, so two names cannot be spelled into one identity");
  check(identityOf({ type: "tool_call", name: "get_weather" }) === identityOf({ type: "tool_call", name: "get_weather" }),
    "two calls to the same tool are the same step, whatever they returned — that is the DIFFERENCE, not the identity");
  check(identityOf({ type: "llm_call", name: "router" }) !== identityOf({ type: "router", name: "router" }),
    "and the type is part of it, so a router node and an llm_call named router do not align");
}

console.log("\n§B.2.3's own case: one side retries and everything after it shifts");
{
  // main: llm_call router, tool_call get_weather, state_update
  // published: llm_call router, tool_call get_weather, tool_call get_weather, state_update
  const left = [
    step({ type: "llm_call", name: "router" }),
    step({ type: "tool_call", name: "get_weather", latency_ms: 820, cost: 0.0031 }),
    step({ type: "state_update", name: "merge" }),
  ];
  const right = [
    step({ type: "llm_call", name: "router" }),
    step({ type: "tool_call", name: "get_weather", latency_ms: 795, cost: 0.0028 }),
    step({ type: "tool_call", name: "get_weather", latency_ms: 400, cost: 0.0009 }),
    step({ type: "state_update", name: "merge" }),
  ];
  const diff = diffTraces(left, right);

  // The whole point. A sequence-keyed comparison reports changed,changed,changed,added here.
  check(shape(diff.rows) === "same,changed,added,same", "one added step, and nothing after it reported as moved", shape(diff.rows));
  check(diff.rows[2]!.change === "added" && diff.rows[2]!.left === null, "the retry is an addition with no left side");
  check(diff.rows[3]!.change === "same", "and the state_update after it aligns with its partner rather than shifting");

  const changed = diff.rows[1]!;
  check(changed.differing.join(",") === "cost,latency",
    "the step that ran on both sides reports WHICH of the three moved", changed.differing.join(","));
  check(!changed.differing.includes("output"), "…and not the one that did not");
}

console.log("\na step that returned something else, for the same money");
{
  const left = [step({ type: "tool_call", name: "get_weather", output: { temp: 12 }, cost: 0.001, latency_ms: 100 })];
  const right = [step({ type: "tool_call", name: "get_weather", output: { temp: 19 }, cost: 0.001, latency_ms: 100 })];
  const diff = diffTraces(left, right);
  check(diff.rows[0]!.differing.join(",") === "output", "output alone, which is a different finding from a price change");

  const same = diffTraces(
    [step({ type: "tool_call", name: "t", output: { a: 1, b: 2 } })],
    [step({ type: "tool_call", name: "t", output: { a: 1, b: 2 } })],
  );
  check(same.rows[0]!.change === "same", "structurally equal outputs are equal, not merely non-identical objects");
}

console.log("\nsteps that only one side takes");
{
  const left = [step({ type: "tool_call", name: "gmail_search" }), step({ type: "state_update", name: "merge" })];
  const right = [step({ type: "tool_call", name: "order_lookup" }), step({ type: "state_update", name: "merge" })];
  const diff = diffTraces(left, right);
  // A replacement reads top-to-bottom as "this went, that came", which is the order every diff
  // renderer in this app already draws a `-` above a `+`.
  check(shape(diff.rows) === "removed,added,same", "a replaced tool is a removal then an addition", shape(diff.rows));
  check(diff.rows[0]!.left?.name === "gmail_search" && diff.rows[1]!.right?.name === "order_lookup",
    "each with only the side it exists on");

  check(shape(diffTraces([], right).rows) === "added,added", "an empty left side is all additions");
  check(shape(diffTraces(left, []).rows) === "removed,removed", "and an empty right side is all removals");
  check(diffTraces([], []).rows.length === 0, "two empty traces have nothing to say");
}

console.log("\nthe totals, with null as its own value");
{
  const priced = [
    step({ type: "llm_call", name: "router", cost: 0.002, latency_ms: 100 }),
    step({ type: "tool_call", name: "t", cost: 0.001, latency_ms: 50 }),
    step({ type: "state_update", name: "merge", latency_ms: 5 }),
  ];
  const unpriced = [
    step({ type: "llm_call", name: "router", cost: null, latency_ms: 90 }),
    step({ type: "tool_call", name: "t", cost: 0.001, latency_ms: 40 }),
    step({ type: "state_update", name: "merge", latency_ms: 5 }),
  ];
  const diff = diffTraces(priced, unpriced);

  check(diff.leftCostUsd !== null && Math.abs(diff.leftCostUsd - 0.003) < 1e-9,
    "a fully priced trace sums", String(diff.leftCostUsd));
  // The eval dashboard's costIncomplete rule: a footer reading $0.001 when one call could not be
  // priced is an exact-looking floor, and two floors compared is a comparison of nothing.
  check(diff.rightCostUsd === null, "one unpriced step nulls the whole total rather than understating it");

  // A state_update has no cost by construction. Treating its null as "unpriced" would make every
  // trace in the system unpriceable.
  check(diff.leftCostUsd !== null, "…and a state_update's absent cost is not an unpriced step");

  check(diff.leftLatencyMs === 155 && diff.rightLatencyMs === 135, "latency sums on both sides",
    `${diff.leftLatencyMs}/${diff.rightLatencyMs}`);
  check(diffTraces([], []).leftCostUsd === 0, "an empty trace costs zero, which is a real answer");
}

console.log("\na step that stopped being metered has changed");
{
  const diff = diffTraces(
    [step({ type: "tool_call", name: "t", cost: 0 })],
    [step({ type: "tool_call", name: "t", cost: null })],
  );
  check(diff.rows[0]!.differing.includes("cost"),
    "zero and null are different answers, so moving between them is a change");
}

console.log("\nwhere a shadow run stages, and when it is reclaimed");
{
  const a = shadowStagingId("a1b2c3d4e5f6a7b8c9d0");
  const b = shadowStagingId("a1b2c3d4e5f6a7b8c9d0");
  check(a.includes("__shadow-a1b2c3d4e5f6"), "the sha is in the name, so a staging root is readable", a);
  check(a !== b, "and so is a random half — two people shadowing the same ref do not share a directory");

  const base: ShadowRun = {
    id: "s1", agent_id: "a1", link_id: null, ref: "feat/x", head_sha: "abc",
    run_id: "run-1", staging_key: "k", status: "completed", error: null,
    created_at: new Date(0).toISOString(), ended_at: new Date(0).toISOString(), swept_at: null,
  };
  const now = SWEEP_AFTER_MS + 1000;

  check(shouldSweep(base, now), "a finished run past the window is reclaimed");
  check(!shouldSweep(base, SWEEP_AFTER_MS - 1000), "and one inside it is not");
  check(!shouldSweep({ ...base, swept_at: new Date(0).toISOString() }, now), "nothing is swept twice");
  check(!shouldSweep({ ...base, staging_key: null }, now), "a run that never staged has nothing to reclaim");
  // The conservative direction, and the same one the eval cleanup takes: a row with no end time may
  // be a run still executing on another replica, and pulling its project out from under it is worse
  // than leaving a directory on disk.
  check(!shouldSweep({ ...base, ended_at: null, status: "running" }, now * 1000),
    "a run with no end time is never swept, however old it looks");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

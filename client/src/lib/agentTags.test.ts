// §5.4's three rules, as rules: precedence, one-per-family, and the overflow count.
//
// WHY THIS SUITE EXISTS AT ALL. The tag row is the densest thing on the Agents grid and the main
// reason it is scannable, so §5.4 gives it explicit rules rather than leaving it to judgement — and
// the rules are the kind that pass a screenshot and fail a workspace. The one the specification calls
// out by name is an agent that is both failing and new: it must show `Failing` first, because the
// problem always outranks the novelty, and a row that appended tags in the order somebody wrote the
// conditionals would show `New`.
//
// AND THE COLOUR LAW IS ASSERTED, not merely commented. v0.2.2 redrew the wordmark because an amber
// outline read as a warning sign in an app where amber already means running; the same mistake here
// is one `tone: "amber"` on a rose tag, in a file of thirty of them, and nothing but a check would
// catch it.
//
//   npm run test:agent-tags

import {
  NEW_WINDOW_MS, TAG_LIMIT, agentTagRow, agentTags, isNew, type TagInput,
} from "./agentTags.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/** A settled, healthy, unremarkable agent. Every case below is this with one thing changed. */
const base: TagInput = {
  archived_at: null,
  created_at: ago(90 * 24 * 60 * 60 * 1000),
  current_version: 7,
  version_source: "edit",
  runs_7d: 12,
  last_run_at: ago(60 * 60 * 1000),
  runtime: "idle",
  health: "healthy",
  missing_env: [],
  high_impact_tools: 0,
  spend_known: true,
  deployment: null,
  drift: null,
};

const ids = (a: TagInput): string[] => agentTags(a, NOW).map((t) => t.id);

console.log("\none tag per family, resolved before the row is assembled");
{
  const running = agentTags({ ...base, runtime: "running" }, NOW);
  check("Idle and Running can never appear together",
    running.filter((t) => t.family === "runtime").length === 1 &&
    running.some((t) => t.id === "running") && !running.some((t) => t.id === "idle"));

  // Every family, on the most crowded agent this product can produce.
  const crowded: TagInput = {
    ...base,
    archived_at: null,
    runtime: "running",
    health: "failing",
    missing_env: ["SLACK_TOKEN"],
    high_impact_tools: 3,
    spend_known: false,
    deployment: { status: "live", url: "https://x.invalid" },
    drift: { deployed: 5, current: 9 },
    last_run_at: null,
  };
  const families = agentTags(crowded, NOW).map((t) => t.family);
  check("no family appears twice, however much is true at once",
    new Set(families).size === families.length, families.join(", "));

  // The Attention family has three members and an agent can satisfy all three at once.
  check("...including Attention, which resolves to the worst of the three",
    ids(crowded).filter((id) => ["creds-missing", "high-impact", "cost-unknown"].includes(id)).length === 1);
  check("...and a missing credential is what wins it",
    ids(crowded).includes("creds-missing"));
}

console.log("\nprecedence: Attention > Runtime > Deploy > Health > Lifecycle");
{
  // §5.4's OWN EXAMPLE, and the reason precedence is a rule rather than a preference.
  const failingAndNew: TagInput = { ...base, health: "failing", created_at: ago(60 * 1000), last_run_at: null };
  const order = ids(failingAndNew);
  check("an agent that is both failing and new shows Failing before New",
    order.indexOf("failing") < order.indexOf("new"), order.join(" · "));

  const everything: TagInput = {
    ...base,
    missing_env: ["A"],
    runtime: "running",
    drift: { deployed: 5, current: 9 },
    health: "failing",
    created_at: ago(60 * 1000),
    last_run_at: null,
  };
  check("the five families come out in precedence order",
    JSON.stringify(agentTags(everything, NOW).map((t) => t.family)) ===
      JSON.stringify(["attention", "runtime", "deploy", "health", "lifecycle"]),
    agentTags(everything, NOW).map((t) => t.family).join(" · "));
}

console.log("\nat most three render, and the rest go behind a +n chip");
{
  const everything: TagInput = {
    ...base,
    missing_env: ["A"],
    runtime: "running",
    drift: { deployed: 5, current: 9 },
    health: "failing",
    created_at: ago(60 * 1000),
    last_run_at: null,
  };
  const row = agentTagRow(everything, NOW);
  check(`exactly ${TAG_LIMIT} render`, row.shown.length === TAG_LIMIT, String(row.shown.length));
  check("the overflow holds the rest, and the two together are the whole truth",
    row.shown.length + row.overflow.length === agentTags(everything, NOW).length);
  check("...and the ones that render are the most important three",
    JSON.stringify(row.shown.map((t) => t.id)) === JSON.stringify(["creds-missing", "running", "drift"]),
    row.shown.map((t) => t.id).join(" · "));

  const quiet = agentTagRow(base, NOW);
  check("an ordinary agent overflows nothing", quiet.overflow.length === 0, String(quiet.overflow.length));
  check("...and still says something rather than nothing", quiet.shown.length > 0);
}

console.log("\nthe colour law, checked rather than commented");
{
  // Every tag any agent can produce, from a spread of states wide enough to reach all of them.
  const states: TagInput[] = [
    base,
    { ...base, runtime: "running" }, { ...base, runtime: "generating" }, { ...base, runtime: "deploying" },
    { ...base, runtime: "paused" },
    { ...base, health: "failing" }, { ...base, health: "degraded" }, { ...base, health: "unverified" },
    { ...base, missing_env: ["A", "B"] }, { ...base, high_impact_tools: 2 }, { ...base, spend_known: false },
    { ...base, deployment: { status: "live", url: null } },
    { ...base, drift: { deployed: 1, current: 2 }, deployment: { status: "live", url: null } },
    { ...base, archived_at: ago(1000) },
    { ...base, forked_from: "api_gateway" },
    { ...base, current_version: 1, version_source: null },
    { ...base, created_at: ago(1000), last_run_at: null },
  ];
  const all = states.flatMap((s) => agentTags(s, NOW));
  const seen = new Map(all.map((t) => [t.id, t]));

  // AMBER IS RUNTIME ACTIVITY AND NOTHING ELSE. This is the assertion v0.2.2 was written about.
  const amber = [...seen.values()].filter((t) => t.tone === "amber").map((t) => t.id).sort();
  check("only Running, Generating and Deploying are amber",
    JSON.stringify(amber) === JSON.stringify(["deploying", "generating", "running"]), amber.join(", "));

  // A WARNING MUST NEVER BE AMBER. Stated as its own check because it is the rule, and the list
  // above is only the current way of satisfying it.
  for (const id of ["creds-missing", "high-impact", "cost-unknown", "failing", "degraded", "drift"]) {
    const tag = seen.get(id);
    check(`${id} is rose, not amber`, tag?.tone === "rose", tag?.tone);
  }
  check("Unverified is grey, despite being the tag most easily mistaken for a warning",
    seen.get("unverified")?.tone === "grey");
  check("Idle and Archived are grey, because they are inert",
    seen.get("idle")?.tone === "grey" && seen.get("archived")?.tone === "grey");
  check("Live is green, which is the only thing green means",
    seen.get("live")?.tone === "green");
  check("New and Forked are blue, which is the only thing blue means",
    seen.get("new")?.tone === "blue" && seen.get("forked")?.tone === "blue");

  check("every tag carries a sentence for its tooltip and its accessible name",
    [...seen.values()].every((t) => t.title.length > 0));

  // NAMES ONLY. The credential tag's tooltip lists what is missing, which is the actionable half —
  // and there is no path by which a value could reach it, because the input carries none.
  check("the credential tag names what is missing and can carry nothing else",
    seen.get("creds-missing")!.title.includes("A") && seen.get("creds-missing")!.title.includes("B"));
}

console.log("\nDeploy: drift outranks Live within the family, because it is the sharper claim");
{
  const live: TagInput = { ...base, deployment: { status: "live", url: "https://x.invalid" } };
  check("a deployed agent that is up to date says Live", ids(live).includes("live"));
  const drifted: TagInput = { ...live, drift: { deployed: 5, current: 9 } };
  check("...and a drifted one says v5 → v9 INSTEAD of Live, not beside it",
    ids(drifted).includes("drift") && !ids(drifted).includes("live"));
  check("...with the two versions in the label, left to right, live then current",
    agentTags(drifted, NOW).find((t) => t.id === "drift")?.label === "v5 → v9");
  check("an agent with nothing deployed says nothing about deploying",
    !ids(base).some((id) => id === "live" || id === "drift"));
}

console.log("\nNew is created-recently OR never-run, which is §5.4's own wording");
{
  check("an agent created an hour ago is new",
    isNew({ created_at: ago(60 * 60 * 1000), runs_7d: 3, last_run_at: ago(1000) }, NOW));
  check("an agent created three months ago and running daily is not",
    !isNew({ created_at: ago(90 * 24 * 60 * 60 * 1000), runs_7d: 20, last_run_at: ago(1000) }, NOW));

  // THE `OR` IS THE INTERESTING HALF. A rule that only looked at `created_at` would call this
  // established on the strength of having sat there.
  check("...but an agent created three months ago that has NEVER run is new again",
    isNew({ created_at: ago(90 * 24 * 60 * 60 * 1000), runs_7d: 0, last_run_at: null }, NOW));
  check("the window is exactly seven days",
    isNew({ created_at: ago(NEW_WINDOW_MS - 1000), runs_7d: 1, last_run_at: ago(1) }, NOW) &&
    !isNew({ created_at: ago(NEW_WINDOW_MS + 1000), runs_7d: 1, last_run_at: ago(1) }, NOW));
}

console.log("\nlifecycle resolves to one, in the order the card needs it");
{
  check("an archived agent says Archived and nothing else about its lifecycle",
    ids({ ...base, archived_at: ago(1000), forked_from: "x", created_at: ago(1000), last_run_at: null })
      .filter((id) => ["archived", "forked", "draft", "new"].includes(id)).length === 1);
  check("a fork says Forked rather than New, even in its first hour",
    ids({ ...base, forked_from: "api_gateway", created_at: ago(1000), last_run_at: null }).includes("forked"));
  check("an agent with nothing published says Draft",
    ids({ ...base, current_version: 1, version_source: null }).includes("draft"));
}

console.log("\nRuntime and Health never collapse (§5.4's own example)");
{
  const idleAndFailing = agentTags({ ...base, runtime: "idle", health: "failing" }, NOW);
  check("Idle · Failing renders as two tags on two axes",
    idleAndFailing.some((t) => t.id === "idle" && t.family === "runtime") &&
    idleAndFailing.some((t) => t.id === "failing" && t.family === "health"),
    idleAndFailing.map((t) => t.id).join(" · "));

  // And the pair survives the trim, which is the version of this that actually reaches a screen.
  const row = agentTagRow({ ...base, runtime: "idle", health: "failing" }, NOW);
  check("...and both are still visible after the row is trimmed to three",
    row.shown.some((t) => t.id === "idle") && row.shown.some((t) => t.id === "failing"),
    row.shown.map((t) => t.id).join(" · "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

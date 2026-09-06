// I3 and I4: one vocabulary across every domain, and every map exhaustive at compile time.
//
// I4 IS A TYPECHECK PROPERTY AND THIS SUITE IS ITS SECOND HALF. `Record<WorkStatus, Phase>` already
// makes a missing member a build failure — that is the guard that matters, because it fires on the
// state somebody adds next year rather than on the ones anybody thought to write a case for. What a
// typechecker cannot do is notice that the union it is checking against has been WIDENED somewhere
// else, or that a map was made `Partial`, or that a comparison state was quietly given a phase to
// make an error go away. So this reads the unions out of `types.ts` AS TEXT and holds every map to
// them, which is the same shape `test:entitlements` uses over `wsRelay.ts` and for the same reason:
// the failure is a member that exists and is mapped nowhere, and nothing in the module graph can see
// it once somebody has silenced the compiler.
//
// I3 IS THE HALF NOBODY CAN TYPE. A dashed ring means "not begun" in every tab or the vocabulary is
// worthless, and no `Record` can say that. What CAN be asserted is the mechanical residue of it:
// every one of the seven phases is reached by at least one domain (a shape nobody uses is a shape
// nobody learns), nothing reaches a phase outside the seven, and the states that reach `active` are
// exactly the ones that are genuinely in flight — enumerated here rather than derived, because a
// table that derived its own answer would pass with a row deleted.
//
// AND §3'S EXCLUSIONS ARE ASSERTED AS ABSENCES, which is the direction they actually fail in.
// Nobody maps `ahead` to `done` on purpose; they do it because a `Record<SyncState, Phase>` would not
// compile otherwise and the fastest way to make it compile is to pick something.
//
//   npm run test:status-map

import {
  AGENT_HEALTH_AXIS,
  AGENT_RUNTIME_PHASE,
  DEPLOY_PHASE,
  EVAL_PHASE,
  MCP_PHASE,
  RUN_PHASE,
  SYNC_COMPARISON,
  SYNC_PHASE,
  THREAD_PHASE,
  WORK_PHASE,
  agentPhase,
  deployPhase,
  syncPhase,
} from "./domainPhase.ts";
import { PHASES, type Phase } from "./statusPhase.ts";
import { check, done, read } from "./icons/harness.ts";

const TYPES = read("src/types.ts");

/** The members of `export type X = "a" | "b";`, read out of the source rather than the module. */
const union = (name: string): string[] => {
  const m = TYPES.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
  return m ? [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort() : [];
};

/** The members of a string-union FIELD on an interface — `runtime`, `health`. */
const field = (name: string): string[] => {
  const m = TYPES.match(new RegExp(`\\n  ${name}: ("[a-z_]+"(?: \\| "[a-z_]+")*);`));
  return m ? [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort() : [];
};

const keys = (map: Record<string, Phase>): string[] => Object.keys(map).sort();
const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// --- 1. every map covers its union, exactly -----------------------------------------------------

console.log("\nevery domain map is exhaustive over the union it is written against");
{
  const DOMAINS: { name: string; members: string[]; map: Record<string, Phase>; excluded?: string[] }[] = [
    { name: "run", members: union("RunStatus"), map: RUN_PHASE },
    { name: "thread", members: union("ThreadStatus"), map: THREAD_PHASE },
    { name: "work item", members: union("WorkStatus"), map: WORK_PHASE },
    { name: "deploy", members: union("DeployStatus"), map: DEPLOY_PHASE },
    { name: "MCP server", members: union("McpServerStatus"), map: MCP_PHASE },
    { name: "eval", members: union("EvalRunStatus"), map: EVAL_PHASE },
    { name: "agent runtime", members: field("runtime"), map: AGENT_RUNTIME_PHASE },
    // The one map with an exclusion, and the one place §3's list has to be subtracted before the
    // two sides can be compared at all.
    { name: "GitHub sync", members: union("SyncState"), map: SYNC_PHASE, excluded: [...SYNC_COMPARISON] },
  ];

  for (const d of DOMAINS) {
    // A UNION THAT READ AS EMPTY would make every check below pass against a map of anything, which
    // is the failure mode of every source-scanning suite. Asserted first, per domain.
    check(`the ${d.name} union was actually read`, d.members.length > 0, `${d.members.length}`);
    const expected = d.members.filter((m) => !(d.excluded ?? []).includes(m)).sort();
    const got = keys(d.map);
    const missing = expected.filter((m) => !got.includes(m));
    const extra = got.filter((m) => !expected.includes(m));
    check(`the ${d.name} map has a phase for every member`, missing.length === 0, missing.join(", "));
    check(`...and nothing the union does not have`, extra.length === 0, extra.join(", "));
    check(`...and every phase it names is one of the seven`,
      Object.values(d.map).every((p) => PHASES.includes(p)),
      Object.values(d.map).filter((p) => !PHASES.includes(p)).join(", "));
  }

  // AND THE UNIONS ARE THE ONES THE BRIEF GOT WRONG, asserted by member count so that a future
  // widening shows up here as well as in the exhaustiveness checks above. These three numbers are
  // the whole argument for I4 existing.
  check("the run union has four members, not the brief's seven", union("RunStatus").length === 4, union("RunStatus").join(", "));
  check("the deploy union has eleven, not nine", union("DeployStatus").length === 11, `${union("DeployStatus").length}`);
  check("the eval union carries aborted_over_budget", union("EvalRunStatus").includes("aborted_over_budget"));
}

// --- 2. the seven are one vocabulary, used --------------------------------------------------------

console.log("\none vocabulary, many domains, no local shapes");
{
  const ALL_MAPS = [RUN_PHASE, THREAD_PHASE, WORK_PHASE, DEPLOY_PHASE, MCP_PHASE, EVAL_PHASE, AGENT_RUNTIME_PHASE, SYNC_PHASE];
  const reached = new Set<Phase>(ALL_MAPS.flatMap((m) => Object.values(m) as Phase[]));
  // A SHAPE NOBODY USES IS A SHAPE NOBODY LEARNS, and it is also the sign of a phase invented for
  // the table rather than for the product. `pending` reaches this set through the deploy and sync
  // maps; `ready` through threads and agent runtime.
  const unused = PHASES.filter((p) => !reached.has(p));
  check("every phase is reached by some domain", unused.length === 0, unused.join(", "));
  check("and nothing reaches anything else", [...reached].every((p) => PHASES.includes(p)));

  // AMBER'S MEANING IS THE SAME SENTENCE IN EVERY DOMAIN, which is I3 at the one place it is worth
  // the most. Written out rather than derived: a check that computed this list from the maps would
  // agree with them however wrong they were.
  const IN_FLIGHT: Record<string, string[]> = {
    run: ["running"],
    thread: ["running"],
    "work item": ["running"],
    deploy: ["queued", "packaging", "uploading", "building", "deploying"],
    eval: ["running"],
    "agent runtime": ["running", "generating", "deploying"],
    "GitHub sync": ["syncing"],
  };
  const actives: Record<string, string[]> = {
    run: Object.keys(RUN_PHASE).filter((k) => RUN_PHASE[k as keyof typeof RUN_PHASE] === "active"),
    thread: Object.keys(THREAD_PHASE).filter((k) => THREAD_PHASE[k as keyof typeof THREAD_PHASE] === "active"),
    "work item": Object.keys(WORK_PHASE).filter((k) => WORK_PHASE[k as keyof typeof WORK_PHASE] === "active"),
    deploy: Object.keys(DEPLOY_PHASE).filter((k) => DEPLOY_PHASE[k as keyof typeof DEPLOY_PHASE] === "active"),
    eval: Object.keys(EVAL_PHASE).filter((k) => EVAL_PHASE[k as keyof typeof EVAL_PHASE] === "active"),
    "agent runtime": Object.keys(AGENT_RUNTIME_PHASE).filter((k) => AGENT_RUNTIME_PHASE[k as keyof typeof AGENT_RUNTIME_PHASE] === "active"),
    "GitHub sync": Object.keys(SYNC_PHASE).filter((k) => SYNC_PHASE[k as keyof typeof SYNC_PHASE] === "active"),
  };
  for (const [domain, expected] of Object.entries(IN_FLIGHT)) {
    check(`${domain} is amber only where work is happening`,
      same(expected.slice().sort(), actives[domain]!.slice().sort()),
      `${actives[domain]!.join(", ")} vs ${expected.join(", ")}`);
  }
  // MCP HAS NO ACTIVE STATE AT ALL, which is worth asserting rather than leaving as an absence in a
  // table above: a server is connected or it is not, and a "connecting" phase would be a shape for a
  // state the union does not have.
  check("an MCP server is never amber",
    !Object.values(MCP_PHASE).includes("active"), Object.entries(MCP_PHASE).join("; "));
}

// --- 3. §3, asserted as an absence -----------------------------------------------------------------

console.log("\nthe axis that is not a phase keeps its own treatment");
{
  check("the sync exclusion is exactly the three positions",
    same([...SYNC_COMPARISON].sort(), ["ahead", "behind", "diverged"]), SYNC_COMPARISON.join(", "));
  for (const state of SYNC_COMPARISON) {
    check(`${state} has no phase`, !(state in SYNC_PHASE));
    check(`...and asking for one answers null`, syncPhase(state) === null, String(syncPhase(state)));
  }
  // AND THE FOUR THAT DO have one, so the null above is a decision rather than a broken function.
  for (const state of ["unlinked", "syncing", "in_sync", "broken"] as const) {
    check(`${state} still resolves`, syncPhase(state) !== null);
  }

  // AGENT HEALTH IS THE SECOND EXCLUSION, and D1's whole argument: the grid holds Runtime and Health
  // as separate axes because "Idle · Failing" is a real state. So no health value may appear as a
  // key of the runtime map, in either direction.
  check("the health axis is all four values",
    same([...AGENT_HEALTH_AXIS].sort(), ["degraded", "failing", "healthy", "unverified"]),
    AGENT_HEALTH_AXIS.join(", "));
  check("the health axis is the field's own union",
    same([...AGENT_HEALTH_AXIS].sort(), field("health")), field("health").join(", "));
  const bled = AGENT_HEALTH_AXIS.filter((h) => h in AGENT_RUNTIME_PHASE);
  check("no health value has a phase", bled.length === 0, bled.join(", "));

  // AND THE THIRD, WHICH HAS NO UNION TO EXCLUDE IT FROM. `drifted` is a comparison the deploy panel
  // draws from a `drift` field; it is not a `DeployStatus`, so the only way it could acquire a phase
  // is somebody adding a key by hand. Read as text, because there is nothing else to read.
  const source = read("src/lib/domainPhase.ts").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("drifted is mapped nowhere", !/^\s*drift(ed)?:/m.test(source));
}

// --- 4. the two facts a union cannot carry ---------------------------------------------------------

console.log("\nthe states that are an absence rather than a status");
{
  // "NEVER DEPLOYED → pending" is an absent row, and a call site that had to remember this is a call
  // site with a hole in its glyph column the first time an agent has never been deployed.
  check("no deployment is pending", deployPhase(null) === "pending", deployPhase(null));
  check("...and undefined is too", deployPhase(undefined) === "pending");
  check("a live deployment is done", deployPhase({ status: "live" }) === "done");

  // §9'S LADDER, RUNG 1: an archived card is quiet regardless of what it used to be doing.
  const archived = agentPhase({ runtime: "running", archived_at: "2026-01-01T00:00:00Z", last_run_at: "2026-01-01T00:00:00Z" });
  check("archiving outranks running", archived === "halted", archived);
  const never = agentPhase({ runtime: "idle", archived_at: null, last_run_at: null });
  check("an agent that has never run is pending", never === "pending", never);
  const idle = agentPhase({ runtime: "idle", archived_at: null, last_run_at: "2026-01-01T00:00:00Z" });
  check("...and one that has is ready", idle === "ready", idle);
  const busy = agentPhase({ runtime: "generating", archived_at: null, last_run_at: null });
  // GENERATING WITH NO RUNS YET IS STILL BUSY. The "never run" branch is about an IDLE agent; an
  // agent mid-generation has begun by any reading, and reporting it as "not started" would be the
  // one wrong answer this function can give while looking correct in every other case.
  check("a generating agent with no runs is active", busy === "active", busy);
}

done();

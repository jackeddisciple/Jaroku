// The order the composer's chooser offers agents in — see recentAgent.ts.
//
// Every case here is a way of offering the wrong two agents that would only show on somebody's
// screen: the newest agent instead of the one they were in, an archived session still counting, a
// deleted agent's thread slipping in, an older session beating a newer one on the same agent.
//
//   npm run test:recent-agent

import { recentAgents } from "./recentAgent.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const agent = (agent_id: string, created_at: string | null = null) => ({ agent_id, created_at });
const thread = (agent_id: string | null, last_activity_at: string, archived_at: string | null = null) =>
  ({ agent_id, last_activity_at, archived_at });

console.log("\nthe agents somebody last worked in come first");
{
  const agents = [agent("billing", "2026-09-01T00:00:00Z"), agent("rovan", "2026-08-01T00:00:00Z")];
  const threads = [thread("billing", "2026-09-09T10:00:00Z"), thread("rovan", "2026-09-10T08:00:00Z")];
  const order = recentAgents(agents, threads).join(",");
  check("the latest thread activity first", order === "rovan,billing", order);
  const two = [thread("rovan", "2026-09-01T00:00:00Z"), thread("rovan", "2026-09-10T12:00:00Z"),
    thread("billing", "2026-09-09T00:00:00Z")];
  check("an agent's latest session is the one that counts", recentAgents(agents, two)[0] === "rovan",
    recentAgents(agents, two).join(","));
}

console.log("\nwhat does not count as working in it");
{
  const agents = [agent("billing"), agent("rovan")];
  const archived = [
    thread("billing", "2026-09-09T10:00:00Z"),
    thread("rovan", "2026-09-10T08:00:00Z", "2026-09-10T09:00:00Z"),
  ];
  check("an archived session is ignored", recentAgents(agents, archived).join(",") === "billing,rovan",
    recentAgents(agents, archived).join(","));
  const gone = [thread("deleted", "2026-09-10T12:00:00Z"), thread("rovan", "2026-09-01T00:00:00Z")];
  check("a session for an agent no longer listed adds nobody", recentAgents(agents, gone).join(",") === "rovan,billing",
    recentAgents(agents, gone).join(","));
  const orphan = [thread(null, "2026-09-10T12:00:00Z"), thread("billing", "2026-09-02T00:00:00Z")];
  check("a session with no agent is ignored", recentAgents(agents, orphan)[0] === "billing",
    recentAgents(agents, orphan).join(","));
}

console.log("\nnobody has worked in some of them yet");
{
  const agents = [agent("old", "2026-08-01T00:00:00Z"), agent("new", "2026-09-05T00:00:00Z")];
  check("with no sessions at all, the newest first", recentAgents(agents, []).join(",") === "new,old",
    recentAgents(agents, []).join(","));
  const undated = [agent("first"), agent("second")];
  check("where no dates are known, list order holds", recentAgents(undated, []).join(",") === "first,second",
    recentAgents(undated, []).join(","));
  const mixed = [agent("used", "2026-08-01T00:00:00Z"), agent("fresh", "2026-09-09T00:00:00Z")];
  check("an agent with a session outranks a newer one without",
    recentAgents(mixed, [thread("used", "2026-08-02T00:00:00Z")]).join(",") === "used,fresh",
    recentAgents(mixed, [thread("used", "2026-08-02T00:00:00Z")]).join(","));
}

console.log("\nevery agent is listed exactly once");
{
  const agents = [agent("a"), agent("b"), agent("c")];
  const order = recentAgents(agents, [thread("b", "2026-09-10T00:00:00Z"), thread("b", "2026-09-09T00:00:00Z")]);
  check("no agent dropped or repeated", order.length === 3 && new Set(order).size === 3, order.join(","));
  check("an empty workspace offers nothing", recentAgents([], [thread("x", "2026-09-10T00:00:00Z")]).length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

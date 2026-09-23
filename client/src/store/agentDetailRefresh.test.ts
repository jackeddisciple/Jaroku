// The open agent detail asks again when a snapshot moves what it was built from — and only then.
//
// THE BUG: after a Restore issued from the pane, its header moved to v5 while the version list below
// still marked v4 LIVE. The store kept the detail's non-card half across every snapshot on the
// grounds that it was "still true", which holds for a broadcast about another agent and not for one
// about this agent's versions, grants or runs.
//
//   npm run test:agent-detail-refresh

import { detailBasis, useAgentGridStore } from "./agentGridStore.ts";
import type { AgentCardView, AgentDetailView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const card = (over: Partial<AgentCardView> & { slug: string }): AgentCardView => ({
  agent_id: over.slug, name: over.slug, uuid: `uuid-${over.slug}`, description: null,
  created_at: "2026-08-01T00:00:00.000Z", created_by: null, archived_at: null, hand_written: false,
  forked_from: null, category: "Uncategorized", picture: "agent-01", current_version: 4,
  version_source: "deploy", creation_cost: null, connectors: [], mcp_tools: ["notion/search_pages"],
  required_env: [], missing_env: [], high_impact_tools: 0, default_provider: "anthropic",
  last_provider: null, last_model: null, thread_count: 1, latest_thread: null, runtime: "idle",
  health: "healthy", activity: "quiet", last_run_at: null, runs_7d: 0, errors_7d: 0, outcomes: [],
  last_error: null, spend_7d: null, spend_known: true, deployment: null, drift: null,
  ...over,
});

const detailOf = (c: AgentCardView): AgentDetailView => ({
  card: c, versions: [], tools: [], credentials: [], p50_ms: null, p95_ms: null,
  cost_per_run_7d: null, cost_per_run_30d: null, evals: { datasets: [], last: null },
  threads: [], runs: [],
});

const store = useAgentGridStore;
const raven = card({ slug: "raven" });
const bruno = card({ slug: "bruno" });

const open = (c: AgentCardView): void => {
  store.getState().setGrid([c, bruno], false);
  store.getState().startDetail(c.slug);
  store.getState().setDetail(detailOf(c));
};

console.log("\na snapshot about something else leaves the open detail alone");
{
  open(raven);
  store.getState().setGrid([raven, { ...bruno, current_version: 9 }], false);
  check("another agent's new version does not mark this one stale", !store.getState().detailStale);
  store.getState().setGrid([{ ...raven, name: "Raven the Second", category: "Research" }, bruno], false);
  check("...nor does this agent's own rename or category — the header follows those by itself",
    !store.getState().detailStale);
  check("...and the header did follow", store.getState().detail?.card.name === "Raven the Second");
}

console.log("\n...but one that moved what the detail was built from marks it stale");
{
  open(raven);
  store.getState().setGrid([{ ...raven, current_version: 5, version_source: "generation" }, bruno], false);
  check("a Restore's new live version does", store.getState().detailStale);

  open(raven);
  store.getState().setGrid([{ ...raven, current_version: 5, mcp_tools: [] }, bruno], false);
  check("a grant change does", store.getState().detailStale);

  open(raven);
  store.getState().setGrid([{ ...raven, missing_env: ["SLACK_BOT_TOKEN"] }, bruno], false);
  check("a credential going missing does", store.getState().detailStale);

  open(raven);
  store.getState().setGrid([{
    ...raven, outcomes: [{ run_id: "r1", outcome: "ok", started_at: "2026-09-20T00:00:00Z", failed_step_id: null }],
  }, bruno], false);
  check("a new run does — Recent runs and the percentiles are read from runs", store.getState().detailStale);
}

console.log("\nasking again clears it, and the answer settles it without asking forever");
{
  open(raven);
  const moved = { ...raven, current_version: 5 };
  store.getState().setGrid([moved, bruno], false);
  store.getState().startDetail("raven");
  check("sending the request clears the flag, so the pane asks once", !store.getState().detailStale);
  check("...and keeps the detail on screen while it waits", store.getState().detail?.card.slug === "raven");
  store.getState().setDetail(detailOf(moved));
  check("the answer lands settled", !store.getState().detailStale);

  // AN ANSWER NEWER THAN THE GRID must not loop. Spend is metered without a snapshot, so a detail
  // can carry a figure the grid has not caught up with; comparing every answer to the grid would ask
  // again and again for as long as it had not.
  store.getState().startDetail("raven");
  store.getState().setDetail(detailOf({ ...moved, spend_7d: 0.42 }));
  check("an answer ahead of the grid is not treated as stale", !store.getState().detailStale);
}

console.log("\n...unless the snapshot that moved it arrived while the request was in flight");
{
  open(raven);
  store.getState().startDetail("raven");
  store.getState().setGrid([{ ...raven, current_version: 6 }, bruno], false);
  check("a snapshot mid-flight marks it", store.getState().detailStale);
  // The answer was assembled before the snapshot's change reached it.
  store.getState().setDetail(detailOf(raven));
  check("...and an answer that predates it leaves it marked, so the pane asks once more",
    store.getState().detailStale);
  store.getState().startDetail("raven");
  store.getState().setDetail(detailOf({ ...raven, current_version: 6 }));
  check("...which settles it", !store.getState().detailStale);
}

console.log("\nthe basis is the facts the detail reads, not the whole card");
{
  check("a spend change is part of it — the cost-per-run figures come from it",
    detailBasis(raven) !== detailBasis({ ...raven, spend_7d: 1 }));
  check("a picture is not", detailBasis(raven) === detailBasis({ ...raven, picture: "agent-02" }));
  store.getState().closeDetail();
  check("closing clears everything", !store.getState().detailStale && store.getState().detailBuiltFrom === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

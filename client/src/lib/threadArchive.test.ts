// §3.4's notice: what it names, and when it says nothing at all.
//
// The second half is the one worth the file. A notice on EVERY archive would be a confirmation dialog
// with the buttons rearranged — it would train people to dismiss the bar without reading it, and the one
// that actually matters ("you just discarded a diff you spent money on") would go with the rest. So an
// idle thread produces null, and this asserts it for every non-blocked status rather than for one.
//
//   npm run test:thread-archive

import { archiveNotice } from "./threadArchive.ts";
import type { ThreadStatus, ThreadView } from "../types.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  if (got === want) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

const row = (status: ThreadStatus, fragment: string | null): ThreadView => ({
  id: "t1",
  agent_id: "api_gateway",
  agent_name: "api_gateway",
  agent_deleted: false,
  title: "Stripe webhook retry logic",
  title_is_custom: false,
  created_by: "u1",
  created_at: "2026-08-01T00:00:00.000Z",
  last_activity_at: "2026-08-01T00:00:00.000Z",
  archived_at: null,
  status,
  fragment,
  cost_usd: 0.04,
  cost_known: true,
  // Part 3's three, at their empty values: nothing asked, and a build thread — which is what
  // every row these fixtures stand in for is.
  ask_cost_usd: null,
  ask_cost_known: true,
  mode: "build",
  preview: null,
  live_run_ids: [],
  live_eval_ids: [],
  eval_progress: null,
  agent_active: 1,
  cost_share_high: false,
});

// --- what was set aside, named -----------------------------------------------------------------
eq("a pending diff is named with its size, as §3.4 writes it",
  archiveNotice(row("needs_you", "diff pending +42−11")),
  "discarded a pending diff (+42−11)");
eq("a plan awaiting confirmation",
  archiveNotice(row("needs_you", "plan awaiting")),
  "set aside a plan awaiting confirmation");
eq("a confirmation a run is blocked on",
  archiveNotice(row("needs_you", "confirmation waiting")),
  "set aside a confirmation a run is waiting on");
eq("a refused generation",
  archiveNotice(row("needs_you", "generation rejected")),
  "set aside a refused generation");
eq("failures nobody retried",
  archiveNotice(row("errored", "3 failed steps")),
  "set aside 3 failed steps nobody retried");

// --- and nothing said when nothing was outstanding ---------------------------------------------
eq("an idle thread gets no notice — there was nothing to name",
  archiveNotice(row("idle", null)), null);
eq("...nor one that had only shipped something", archiveNotice(row("idle", "deployed")), null);
eq("a running thread archived mid-run says nothing either: the run is not work waiting on a person",
  archiveNotice(row("running", "eval 34/120")), null);

// --- a fragment this function has not been taught ----------------------------------------------
// A status added later, or a fragment reworded. Saying something generic beats saying nothing: the
// point of the notice is that something WAS outstanding.
eq("an unfamiliar blocked fragment is still named",
  archiveNotice(row("needs_you", "waiting on the moon")),
  "set aside waiting on the moon");
eq("...and a blocked thread with no fragment at all still gets a sentence",
  archiveNotice(row("needs_you", null)),
  "set aside unfinished work");

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

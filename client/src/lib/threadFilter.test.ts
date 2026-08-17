// §4.4's filter: what each chip is about, and what the substring matches.
//
// The case worth the file is the one that is easy to get subtly wrong: `all` means every ACTIVE thread
// and not every row. If it included archived ones, All would be the single chip whose count did not
// match what clicking it shows — and once one number beside a chip is wrong, none of the five is worth
// reading.
//
// The second is composition. The chip narrows and then the query narrows again, so "Archived" plus
// `webhook` is the archived threads mentioning webhook. Any other reading makes it impossible to find
// the thing you archived last week, which is the only reason to open that chip.
//
//   npm run test:thread-filter

import { filterThreads, matchesQuery, THREAD_FILTERS } from "./threadFilter.ts";
import type { ThreadStatus, ThreadView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const t = (
  id: string,
  status: ThreadStatus,
  over: Partial<ThreadView> = {},
): ThreadView => ({
  id,
  agent_id: "api_gateway",
  agent_name: "api_gateway",
  agent_deleted: false,
  title: id,
  title_is_custom: false,
  created_by: "u1",
  created_at: "2026-08-01T00:00:00.000Z",
  last_activity_at: "2026-08-01T00:00:00.000Z",
  archived_at: status === "archived" ? "2026-08-02T00:00:00.000Z" : null,
  status,
  fragment: null,
  cost_usd: null,
  cost_known: true,
  preview: null,
  live_run_ids: [],
  eval_progress: null,
  agent_active: 1,
  ...over,
});

const ids = (list: ThreadView[]): string => list.map((x) => x.id).sort().join(",");

const LIST = [
  t("blocked", "needs_you"),
  t("stopped", "errored"),
  t("live", "running"),
  t("quiet", "idle"),
  t("filed", "archived"),
];

// --- 1. what each chip is about ---------------------------------------------------------------
{
  check("All is every ACTIVE thread, and archived is not one of them",
    ids(filterThreads(LIST, "all", "")) === "blocked,live,quiet,stopped", ids(filterThreads(LIST, "all", "")));
  check("Needs you is both blocked statuses",
    ids(filterThreads(LIST, "needs_you", "")) === "blocked,stopped");
  check("Running is what is in flight", ids(filterThreads(LIST, "running", "")) === "live");
  check("Recent is everything else that is not archived",
    ids(filterThreads(LIST, "recent", "")) === "quiet");
  check("Archived is the ones behind the filter", ids(filterThreads(LIST, "archived", "")) === "filed");
  check("the five chips are in the order the 1–5 shortcuts jump by",
    THREAD_FILTERS.join(",") === "all,needs_you,running,recent,archived");
}

// --- 2. the substring ------------------------------------------------------------------------
{
  const rows = [
    t("a", "idle", { title: "Stripe webhook retry logic" }),
    t("b", "idle", { title: "OAuth token refresh", agent_name: "auth_agent" }),
    t("c", "idle", { title: "Slack digest bot", preview: "why is the WEBHOOK 401ing?" }),
  ];
  check("the title matches", ids(filterThreads(rows, "all", "webhook")) === "a,c");
  check("...case-insensitively, in both directions", ids(filterThreads(rows, "all", "WEBHOOK")) === "a,c");
  check("the agent name matches", ids(filterThreads(rows, "all", "auth_agent")) === "b");
  check("the preview matches", ids(filterThreads(rows, "all", "401ing")) === "c");
  check("a mis-match returns nothing rather than the nearest thing",
    filterThreads(rows, "all", "webhok").length === 0);
  check("an empty query matches everything", filterThreads(rows, "all", "").length === 3);
  check("...and so does a query of spaces, so typing one does not empty the list",
    filterThreads(rows, "all", "   ").length === 3);

  // A deleted agent's name is still in the snapshot, which is what makes the thread findable by what
  // it was built against — the whole reason §3.2 keeps that column.
  const orphan = t("d", "idle", { agent_id: null, agent_name: "legacy_bot", agent_deleted: true });
  check("a deleted agent's name is still searchable", matchesQuery(orphan, "legacy_bot"));
  check("a thread with no agent and no preview matches only its title",
    matchesQuery(t("e", "idle", { agent_name: null, title: "Untitled thread" }), "untitled"));
}

// --- 3. the chip and the query compose --------------------------------------------------------
{
  const rows = [
    t("filed-webhook", "archived", { title: "Stripe webhook retry logic" }),
    t("filed-other", "archived", { title: "Old cleanup pass" }),
    t("live-webhook", "running", { title: "webhook replay" }),
  ];
  check("Archived plus a query is the archived ones matching it",
    ids(filterThreads(rows, "archived", "webhook")) === "filed-webhook");
  check("...and the live one matching it is under its own chip",
    ids(filterThreads(rows, "running", "webhook")) === "live-webhook");
  check("All plus a query never reaches into the archive",
    ids(filterThreads(rows, "all", "webhook")) === "live-webhook");
}

// --- 4. the input is not mutated --------------------------------------------------------------
{
  const rows = [t("a", "needs_you"), t("b", "idle")];
  const before = rows.map((r) => r.id).join(",");
  filterThreads(rows, "needs_you", "");
  check("the store's own array is left as it was", rows.map((r) => r.id).join(",") === before);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

// §4.2's grouping, and the ordering that is the whole point of it.
//
// The assertion this file exists for is the exception: NEEDS YOU IS OLDEST FIRST. Everywhere else in
// this app a list of anything is newest first, so the natural implementation — and the natural test —
// gets this section wrong in the one direction that matters. A four-day-old pending diff sorting below
// an eighteen-minute-old one is not a cosmetic complaint; the section's stated purpose is that
// forgetting one is the most expensive failure this view can prevent, and the forgotten one is
// precisely the oldest.
//
// The second is the absence: an empty section is not rendered AT ALL. Section presence is itself the
// signal, so this returns two sections rather than three with one marked empty — and a caller cannot
// accidentally render a "NEEDS YOU 0" heading, because there is nothing to render it from.
//
//   npm run test:thread-groups

import { groupThreads, hoursOutstanding, isBlockedThread, STALE_HOURS } from "./threadGroups.ts";
import type { ThreadStatus, ThreadView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A thread with a status and an age in hours, which is all this module reads. */
const t = (id: string, status: ThreadStatus, hoursAgo: number, archived = false): ThreadView => ({
  id,
  agent_id: "api_gateway",
  agent_name: "api_gateway",
  agent_deleted: false,
  title: id,
  title_is_custom: false,
  created_by: "u1",
  created_at: "2026-01-01T00:00:00.000Z",
  last_activity_at: new Date(Date.UTC(2026, 7, 17, 12) - hoursAgo * 3_600_000).toISOString(),
  archived_at: archived ? "2026-08-17T00:00:00.000Z" : null,
  status,
  fragment: null,
  cost_usd: null,
  cost_known: true,
  preview: null,
  live_run_ids: [],
  eval_progress: null,
  agent_active: 1,
  cost_share_high: false,
});

const ids = (list: ThreadView[]): string => list.map((x) => x.id).join(",");

// --- 1. three sections, in the fixed order --------------------------------------------------
{
  const sections = groupThreads([
    t("idle-1", "idle", 2),
    t("running-1", "running", 1),
    t("blocked-1", "needs_you", 3),
  ]);
  check("the order is fixed and does not depend on what arrived first",
    sections.map((s) => s.id).join(",") === "needs_you,running,recent", sections.map((s) => s.id).join(","));
  check("...with the labels §4.1's wireframe writes",
    sections.map((s) => s.label).join(",") === "NEEDS YOU,RUNNING,RECENT");
}

// --- 2. NEEDS YOU IS OLDEST FIRST -----------------------------------------------------------
{
  const sections = groupThreads([
    t("18-minutes", "needs_you", 0.3),
    t("four-days", "needs_you", 96),
    t("one-hour", "needs_you", 1),
  ]);
  const needs = sections.find((s) => s.id === "needs_you")!;
  check("the longest-forgotten blocked thread is on top",
    ids(needs.threads) === "four-days,one-hour,18-minutes", ids(needs.threads));
}

// --- 3. ...and every other section is newest first --------------------------------------------
{
  const sections = groupThreads([
    t("run-old", "running", 5),
    t("run-new", "running", 0.1),
    t("idle-old", "idle", 100),
    t("idle-new", "idle", 1),
  ]);
  check("Running is newest first — live cost is ticking now",
    ids(sections.find((s) => s.id === "running")!.threads) === "run-new,run-old");
  check("Recent is newest first — ordinary browsing",
    ids(sections.find((s) => s.id === "recent")!.threads) === "idle-new,idle-old");
}

// --- 4. errored joins the blocked section, keeping its own glyph -------------------------------
{
  const sections = groupThreads([
    t("errored-old", "errored", 50),
    t("needs-new", "needs_you", 1),
    t("idle", "idle", 2),
  ]);
  const needs = sections.find((s) => s.id === "needs_you")!;
  check("a thread that stopped in error is in Needs You", needs.threads.length === 2);
  check("...ordered oldest-first with the rest of them", ids(needs.threads) === "errored-old,needs-new");
  check("...and its status is untouched, because the glyph is still red",
    needs.threads[0]?.status === "errored");
  check("both blocked statuses answer the shared predicate",
    isBlockedThread(t("a", "needs_you", 1)) && isBlockedThread(t("b", "errored", 1)));
  check("...and nothing else does",
    !isBlockedThread(t("c", "running", 1)) && !isBlockedThread(t("d", "idle", 1))
      && !isBlockedThread(t("e", "archived", 1)));
}

// --- 5. an empty section is not there at all -------------------------------------------------
{
  const onlyIdle = groupThreads([t("a", "idle", 1)]);
  check("with nothing blocked and nothing running, there is one section",
    onlyIdle.length === 1 && onlyIdle[0]?.id === "recent", onlyIdle.map((s) => s.id).join(","));
  check("no threads at all is no sections, not three empty ones", groupThreads([]).length === 0);
  check("...so there is nothing a caller could render a '0 items' heading from",
    groupThreads([]).every((s) => s.threads.length > 0));
}

// --- 6. archived threads are out of this view entirely (§3.4) --------------------------------
{
  const sections = groupThreads([
    t("archived-blocked", "archived", 1, true),
    t("live", "idle", 2),
  ]);
  check("an archived thread is in no section", sections.length === 1 && sections[0]?.id === "recent");
  check("...and the live one is still there", ids(sections[0]!.threads) === "live");
  // The Archived filter renders a flat list of its own; it does not ask for a fourth section.
  check("archiving everything empties the view rather than leaving a section behind",
    groupThreads([t("a", "archived", 1, true)]).length === 0);
}

// --- 7. the staleness threshold -------------------------------------------------------------
{
  const now = Date.UTC(2026, 7, 17, 12);
  check("an hour-old thread is an hour old", Math.round(hoursOutstanding(t("a", "needs_you", 1), now)) === 1);
  check("a four-day-old one is past the threshold",
    hoursOutstanding(t("b", "needs_you", 96), now) > STALE_HOURS);
  check("...and an eighteen-minute-old one is not",
    hoursOutstanding(t("c", "needs_you", 0.3), now) < STALE_HOURS);
  check("an unparseable timestamp is zero rather than a negative age",
    hoursOutstanding({ ...t("d", "needs_you", 1), last_activity_at: "not a date" }, now) === 0);
}

// --- 8. the input is not mutated -------------------------------------------------------------
{
  // `Array.prototype.sort` sorts in place, and the array this is handed is the store's own. A
  // grouping that reordered it would silently rewrite the snapshot every render — and the row order
  // outside the sections would then depend on how many times the view had been drawn.
  const input = [t("a", "needs_you", 1), t("b", "needs_you", 50), t("c", "idle", 2)];
  const before = ids(input);
  groupThreads(input);
  check("the store's own array comes back in the order it went in", ids(input) === before, ids(input));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

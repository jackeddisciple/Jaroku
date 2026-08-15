// The six sync states, including the three nobody can produce by hand.
//
// The whole reason `githubSync.ts` is a pure function is this file. "Somebody force-pushed over
// Jaroku's branch while you had two unpushed versions" is a state that takes two accounts, a
// terminal and a race to reproduce against a real repository — and it is precisely the state where
// getting the answer wrong means offering a pull that silently adopts a history in which the
// user's work never existed.
//
// THE ASSERTION THAT MATTERS MOST is `a rewritten remote is diverged, never behind`. Every other
// case here is arithmetic; that one is the difference between a safe refusal and data loss.
//
//   npm run test:github-sync

import type { GithubLink } from "./db/repositories/github.ts";
import {
  badgeFor, syncVerdict, unpushedVersions, verdictLine, type LocalVersion, type RemoteState,
} from "./githubSync.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

/** A link with only the fields the verdict reads. The rest are never consulted. */
function link(patch: Partial<GithubLink> = {}): GithubLink {
  return {
    id: "link-1",
    agent_id: "agent-1",
    installation_id: "inst-1",
    repo_full_name: "ada/weather",
    branch: "jaroku/weather",
    subdirectory: null,
    include_artifacts: true,
    last_pushed_version_id: null,
    last_pushed_sha: null,
    last_known_remote_sha: null,
    last_synced_at: null,
    created_at: new Date(0).toISOString(),
    ...patch,
  };
}

const v = (version: number, id = `v${version}`, undone: string | null = null): LocalVersion => ({
  id, version, undone_at: undone,
});

/** Reachable, with a branch. The ordinary remote; every case below varies one thing from it. */
const remote = (patch: Partial<RemoteState> = {}): RemoteState => ({
  headSha: "aaa111",
  repoReachable: true,
  ...patch,
});

console.log("\nwhat counts as unpushed");
{
  const versions = [v(14), v(13), v(12), v(11)];
  check(unpushedVersions(versions, null).length === 4, "with nothing ever pushed, everything is");
  check(
    unpushedVersions(versions, "v12").map((x) => x.version).join(",") === "14,13",
    "after v12, only what came after it — by version number, not by list position",
  );
  check(unpushedVersions(versions, "v14").length === 0, "after the newest, nothing is");

  // The badge that could never be cleared. An undone version is off the linear history, so a
  // count that included it would sit at ↑1 forever on an agent whose user pressed Undo.
  const withUndone = [v(15, "v15", "2026-01-01T00:00:00.000Z"), v(14), v(13)];
  check(
    unpushedVersions(withUndone, "v13").map((x) => x.version).join(",") === "14",
    "an undone version is not unpushed work — it is not work at all",
  );
}

console.log("\nthe settled states");
{
  check(syncVerdict(undefined, [], remote()).state === "unlinked", "no link is its own state, not in-sync");

  // Never pushed, nothing local: a freshly linked empty repo is in sync, not "0 behind".
  check(
    syncVerdict(link(), [], remote({ headSha: null })).state === "in_sync",
    "a link with no history and an empty repo is in sync",
  );
  check(
    syncVerdict(link(), [v(11)], remote({ headSha: null })).state === "ahead",
    "...and one local version against an empty repo is ahead, not diverged",
  );

  const pushed = link({ last_pushed_version_id: "v12", last_pushed_sha: "aaa111", last_known_remote_sha: "aaa111" });
  check(syncVerdict(pushed, [v(12)], remote()).state === "in_sync", "matched watermark and nothing local is in sync");

  const ahead = syncVerdict(pushed, [v(14), v(13), v(12)], remote());
  check(ahead.state === "ahead" && ahead.ahead === 2, "two versions past the pointer is ↑2");

  const behind = syncVerdict(pushed, [v(12)], remote({ headSha: "bbb222", behindBy: 1 }));
  check(behind.state === "behind" && behind.behind === 1, "a moved head with nothing local is ↓1");

  // The count is genuinely unknown on the cheap path, and saying so is not the same as saying zero.
  const behindUncounted = syncVerdict(pushed, [v(12)], remote({ headSha: "bbb222" }));
  check(
    behindUncounted.state === "behind" && behindUncounted.behind === null,
    "...and with no compare call, behind carries null rather than a number nobody asked for",
  );
  check(badgeFor(behindUncounted) === "↓", "which the badge renders as ↓ with no digit");
}

console.log("\nthe states that are hard to produce by hand");
{
  const pushed = link({ last_pushed_version_id: "v12", last_pushed_sha: "aaa111", last_known_remote_sha: "aaa111" });

  const diverged = syncVerdict(pushed, [v(14), v(13), v(12)], remote({ headSha: "ccc333", behindBy: 1 }));
  check(diverged.state === "diverged" && diverged.ahead === 2, "both sides moved is diverged, with the local count kept");

  // THE ONE THAT MATTERS. A force-push leaves a head that is not a descendant of ours, so GitHub's
  // compare reports zero commits between them. Read as a count that would be "behind by nothing",
  // which reads as in sync; read as a relationship it is the one case a pull must never be offered
  // for, because pulling adopts a history our commits are absent from.
  const forced = syncVerdict(pushed, [v(12)], remote({ headSha: "ddd444", behindBy: 0 }));
  check(forced.state === "diverged", "a rewritten remote is diverged, never behind");
  check(
    verdictLine(forced, "jaroku/weather").includes("rewritten"),
    "...and says so, rather than reporting a count of zero",
  );

  const revoked = syncVerdict(pushed, [v(14), v(13), v(12)], remote({ tokenRevoked: true }));
  check(revoked.state === "broken" && revoked.reason === "token_revoked", "a revoked token outranks the counts");
  check(
    revoked.ahead === 2,
    "...while still reporting the local work, which is a fact about us and not about GitHub",
  );

  check(
    syncVerdict(pushed, [], remote({ repoReachable: false, headSha: null })).reason === "repo_missing",
    "an unreachable repo is repo_missing, not branch_missing",
  );
  check(
    syncVerdict(pushed, [], remote({ headSha: null })).reason === "branch_missing",
    "a branch that vanished AFTER a push is branch_missing",
  );
  check(
    syncVerdict(link(), [], remote({ headSha: null })).state === "in_sync",
    "...while a branch that never existed is simply not there yet",
  );

  check(
    syncVerdict(pushed, [v(13), v(12)], remote(), { inFlight: true }).state === "syncing",
    "a request in flight outranks every settled answer",
  );
}

console.log("\nthe badge");
{
  const pushed = link({ last_pushed_version_id: "v12", last_pushed_sha: "aaa111", last_known_remote_sha: "aaa111" });
  check(badgeFor(syncVerdict(pushed, [v(12)], remote())) === null, "in sync wears no badge at all");
  check(badgeFor(syncVerdict(pushed, [v(13), v(12)], remote())) === "↑1", "ahead is ↑n");
  check(badgeFor(syncVerdict(pushed, [v(13)], remote({ headSha: "eee", behindBy: 2 }))) === "↕", "diverged is ↕");
  check(badgeFor(syncVerdict(pushed, [], remote({ tokenRevoked: true }))) === "⚠", "broken is ⚠");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

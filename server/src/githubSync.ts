// Where the two lineages stand relative to each other.
//
// This is the arithmetic behind §0's tab badge and §3.5's verdict line, and it is a pure function
// on purpose: it takes what the link remembers, what the local version list says and what the
// remote ref currently is, and returns one of six states with the numbers behind it. No database,
// no network, no clock — which is what makes every state below testable, including the three that
// are almost impossible to produce by hand against a real repository.
//
// THE ASYMMETRY THAT SHAPES EVERYTHING HERE. "Ahead" and "behind" are not two views of one
// quantity, because the two lineages are counted in different units and neither can see the
// other's:
//
//   AHEAD is counted in VERSIONS, locally, exactly. Jaroku owns `agent_versions`; it knows which
//   ones came after `last_pushed_version_id` and it cannot be wrong about that.
//
//   BEHIND is counted in COMMITS, remotely, and only ever approximately until somebody fetches.
//   All the link stores is `last_known_remote_sha` — a watermark from the last time we looked. A
//   head that no longer matches it means SOMETHING happened; how many commits is a question only
//   GitHub can answer, and asking it is what a fetch is for.
//
// So `behind` is optional in the result. A verdict of "↓ behind" that has not been given a count
// says "behind" and not "↓ 0 behind", and that distinction is the same one §A.5 draws between an
// absent count and a zero: not applicable, not nothing.
//
// WHY THE WATERMARK IS COMPARED RATHER THAN THE PUSHED SHA. It would be simpler to ask "does the
// branch head equal what we last pushed" and call anything else behind. That is wrong in exactly
// the case §6 cares most about: after somebody force-pushes over Jaroku's branch, the head is
// neither our commit nor a descendant of it, and the simple check reports "behind" — inviting a
// pull that would quietly adopt a history in which our commits never existed. Comparing against
// the watermark separates "the remote moved forward" from "the remote moved sideways", and the
// second is always `diverged`, never `behind`.

import type { GithubLink } from "./db/repositories/github.ts";

/**
 * The six states, and the rule that there are exactly six.
 *
 * Every one of them has exactly one primary action in §3.5, and adding a seventh would mean
 * inventing a seventh thing for the button to say. `syncing` is here because a request in flight
 * is a real state the badge renders (⟳) rather than a UI flag — a client that inferred it from
 * "some request is pending somewhere" would show it during an unrelated fetch.
 */
export type SyncState =
  /** No live link. The panel shows §2.1's empty state and nothing here is computed. */
  | "unlinked"
  | "in_sync"
  | "ahead"
  | "behind"
  /** Both sides moved, or the remote moved sideways. Never auto-resolved. */
  | "diverged"
  /** Repo gone, branch gone, or the token was revoked. The one state that is not about counts. */
  | "broken"
  | "syncing";

/** Why a link is broken, when it is. Three causes, three different next steps for the user. */
export type BrokenReason = "repo_missing" | "branch_missing" | "token_revoked";

export interface SyncVerdict {
  state: SyncState;
  /** Local versions not yet pushed. Exact — see the header. */
  ahead: number;
  /**
   * Remote commits not yet pulled, or null for "we know the remote moved but not by how much".
   *
   * Null is a real answer and not a missing one. It is what the watermark alone can say, and the
   * verdict line renders it as "behind" rather than as a number it would be inventing.
   */
  behind: number | null;
  reason?: BrokenReason;
  /** The remote head as of this computation, so a caller can store it as the new watermark. */
  remoteSha: string | null;
}

/** What the local side contributes: the versions this agent has, newest first. */
export interface LocalVersion {
  id: string;
  version: number;
  /** Undone versions are off the linear history and are not pushable — see migration 014. */
  undone_at: string | null;
}

export interface RemoteState {
  /** Where the linked branch points, or null when the branch does not exist. */
  headSha: string | null;
  /** Whether the repository itself is still reachable with this token. */
  repoReachable: boolean;
  /** Whether the token was rejected outright. Outranks everything else — see below. */
  tokenRevoked?: boolean;
  /**
   * How far the remote is ahead of what we last pushed, when a fetch has bothered to ask.
   *
   * Optional because the cheap path — the badge poll — does not spend a `compare` call per agent.
   * When present it is used verbatim; when absent the verdict says "behind" without a number.
   */
  behindBy?: number | null;
}

/**
 * Local versions that have not been pushed.
 *
 * BY VERSION NUMBER, NOT BY TIMESTAMP, and not by "everything after the row with that id". Version
 * numbers are the monotonic thing in this system — 008 made them unique per agent and 014 indexed
 * them descending — while `created_at` ties at second resolution when two edits land together, and
 * an id-based walk breaks the moment a version is undone and the pointer moves back past it.
 *
 * UNDONE VERSIONS ARE EXCLUDED. An undone version is off the linear history by definition (014),
 * so counting it as unpushed would show ↑1 forever on an agent whose user pressed Undo and moved
 * on — a badge nothing can clear.
 */
export function unpushedVersions(versions: LocalVersion[], lastPushedVersionId: string | null): LocalVersion[] {
  const live = versions.filter((v) => v.undone_at === null);
  if (!lastPushedVersionId) return live;
  // THE POINTER IS RESOLVED AGAINST THE WHOLE LIST AND NOT THE LIVE ONE, which is the difference
  // between a watermark and a badge nobody can clear. Push v14, press Undo, and v14 leaves the
  // live list while still being the commit sitting on the branch — looked up among live versions
  // only, it is simply absent, and "absent" fell through to "nothing was ever pushed". The panel
  // then reported every version the agent has ever had as unpushed, and the push it offered would
  // have written the entire history onto the branch a second time as new commits.
  //
  // A version number is the anchor, and an undone row still has one. The fallback below is for the
  // case the comment always described and the lookup never reached: a pointer at a row that is not
  // in this list at all, where there is genuinely nothing to anchor on.
  const pushed = versions.find((v) => v.id === lastPushedVersionId);
  if (!pushed) return live;
  return live.filter((v) => v.version > pushed.version);
}

/**
 * The verdict.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN. Each one below outranks the ones after it, and the
 * ranking is by what the user can act on:
 *
 *   1. A REVOKED TOKEN outranks everything, including counts. Ahead and behind are both unknowable
 *      through a credential GitHub is refusing, so reporting "↑2" next to a token that cannot push
 *      would be offering an action that is guaranteed to fail.
 *
 *   2. A MISSING REPO outranks a missing branch, because relinking fixes both and there is nothing
 *      useful to say about a branch inside a repository that is not there.
 *
 *   3. A MISSING BRANCH IS ONLY BROKEN IF WE PUT SOMETHING THERE. Before the first push the branch
 *      is supposed not to exist — that is §6's empty-repo row, and the first push creates it. After
 *      a push, a branch that has vanished is §6's "branch deleted remotely", which offers
 *      recreate-from-last-pushed-version.
 *
 *   4. A SIDEWAYS REMOTE IS DIVERGED, never behind. See the header.
 *
 *   5. Only then do the counts decide.
 */
export function syncVerdict(
  link: GithubLink | undefined,
  versions: LocalVersion[],
  remote: RemoteState,
  opts: { inFlight?: boolean } = {},
): SyncVerdict {
  if (!link) return { state: "unlinked", ahead: 0, behind: null, remoteSha: null };

  const ahead = unpushedVersions(versions, link.last_pushed_version_id).length;

  // In flight beats every settled answer: the numbers below are about to change, and a verdict
  // line that showed the old ones next to a spinner would be arguing with itself.
  if (opts.inFlight) return { state: "syncing", ahead, behind: null, remoteSha: remote.headSha };

  if (remote.tokenRevoked) {
    return { state: "broken", reason: "token_revoked", ahead, behind: null, remoteSha: null };
  }
  if (!remote.repoReachable) {
    return { state: "broken", reason: "repo_missing", ahead, behind: null, remoteSha: null };
  }
  if (remote.headSha === null) {
    // Never pushed: the branch is supposed to be absent, and everything local is ahead.
    if (!link.last_pushed_sha) {
      return { state: ahead > 0 ? "ahead" : "in_sync", ahead, behind: null, remoteSha: null };
    }
    return { state: "broken", reason: "branch_missing", ahead, behind: null, remoteSha: null };
  }

  const watermark = link.last_known_remote_sha ?? link.last_pushed_sha;
  const remoteMoved = watermark !== null && remote.headSha !== watermark;

  // THE SIDEWAYS CASE. `behindBy` of 0 with a moved head means the remote is not a descendant of
  // what we last pushed — a force-push, a reset, or a rewritten history. There is no version of
  // "pull this" that is safe, so it is diverged regardless of what the local count says.
  if (remoteMoved && remote.behindBy === 0) {
    return { state: "diverged", ahead, behind: 0, remoteSha: remote.headSha };
  }
  if (remoteMoved && ahead > 0) {
    return { state: "diverged", ahead, behind: remote.behindBy ?? null, remoteSha: remote.headSha };
  }
  if (remoteMoved) {
    return { state: "behind", ahead: 0, behind: remote.behindBy ?? null, remoteSha: remote.headSha };
  }
  if (ahead > 0) return { state: "ahead", ahead, behind: null, remoteSha: remote.headSha };
  return { state: "in_sync", ahead: 0, behind: 0, remoteSha: remote.headSha };
}

/**
 * The badge, as the tab bar renders it.
 *
 * A STRING RATHER THAN A COMPONENT, computed on the server side of the type boundary, because the
 * same six states are read by the tab label, the sidebar's Synced filter and the header. Three
 * places deriving the same glyph from the same state is three places to disagree about what ↕
 * means.
 */
export function badgeFor(verdict: SyncVerdict): string | null {
  switch (verdict.state) {
    case "unlinked":
    case "in_sync":
      // NOTHING, deliberately. §0's table gives "in sync" no badge at all: a tick beside a tab
      // label is a thing to look at, and the whole point of the badge is that its absence means
      // there is nothing to do.
      return null;
    case "ahead": return `↑${verdict.ahead}`;
    case "behind": return verdict.behind === null ? "↓" : `↓${verdict.behind}`;
    case "diverged": return "↕";
    case "broken": return "⚠";
    case "syncing": return "⟳";
  }
}

/**
 * The one sentence §3.5's verdict line renders, for a state that has a repository behind it.
 *
 * Written here rather than in the panel because the words and the state must not be able to
 * disagree, and because the sidebar's Synced filter shows the same phrase in a tooltip.
 */
export function verdictLine(verdict: SyncVerdict, branch: string): string {
  switch (verdict.state) {
    case "unlinked": return "Not linked to a repository";
    case "in_sync": return `In sync with ${branch}`;
    case "ahead": return `${verdict.ahead} version${verdict.ahead === 1 ? "" : "s"} ahead`;
    case "behind":
      return verdict.behind === null
        ? `${branch} moved on GitHub`
        : `${verdict.behind} commit${verdict.behind === 1 ? "" : "s"} behind`;
    case "diverged":
      return verdict.behind === null || verdict.behind === 0
        ? `Diverged — ${verdict.ahead} ahead, and ${branch} was rewritten`
        : `Diverged — ${verdict.ahead} ahead, ${verdict.behind} behind`;
    case "broken":
      if (verdict.reason === "token_revoked") return "GitHub access was revoked";
      if (verdict.reason === "branch_missing") return `${branch} no longer exists on GitHub`;
      return "Repo not found";
    case "syncing": return "Syncing…";
  }
}

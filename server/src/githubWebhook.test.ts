// The signature is the authentication, so this suite is mostly about refusing.
//
// This endpoint is public by construction — GitHub cannot present a bearer token — and what it
// moves is a workspace's sync state. Every assertion below that begins "a forged" is the reason
// the module exists, and the one that matters most is `no secret configured refuses everything`:
// the failure mode where a deployment that forgot to set the variable silently accepts anything
// is not a degraded feature, it is an open endpoint with a workspace's name on it.
//
//   npm run test:github-webhook

import { createHmac } from "node:crypto";

import { APPROVE_SHA_ACTION } from "./checkPolicy.ts";

import {
  DeliveryLog, parseWebhookEvent, verifyGithubSignature,
  type PushEvent, type SignatureVerdict,
} from "./githubWebhook.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const SECRET = "a-shared-secret";
const sign = (body: string, secret = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** The refusal reason, or null when it verified. `reason` only exists on the failing branch. */
const reasonOf = (v: SignatureVerdict): string | null => (v.ok ? null : v.reason);

console.log("\nthe signature is the authentication");
{
  const body = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40) });

  check(verifyGithubSignature(body, sign(body), SECRET).ok, "a body signed with the secret verifies");

  // THE ONE THAT DECIDES WHETHER THIS IS AN ENDPOINT OR A HOLE.
  const unconfigured = verifyGithubSignature(body, sign(body), undefined);
  check(
    !unconfigured.ok && unconfigured.reason === "not_configured",
    "no secret configured refuses everything — it does not verify nothing and accept",
  );

  const forgedSecret = verifyGithubSignature(body, sign(body, "not-the-secret"), SECRET);
  check(!forgedSecret.ok && forgedSecret.reason === "mismatch", "a forged signature from another secret is refused");

  // A captured signature moved onto a different payload — the replay that matters, since GitHub
  // signs no timestamp and the signature alone stays valid forever.
  const tampered = JSON.stringify({ ref: "refs/heads/main", after: "b".repeat(40) });
  const moved = verifyGithubSignature(tampered, sign(body), SECRET);
  check(!moved.ok && moved.reason === "mismatch", "a real signature over different bytes is refused");

  check(!verifyGithubSignature(body, undefined, SECRET).ok, "no signature header at all is refused");
  check(
    reasonOf(verifyGithubSignature(body, "sha1=deadbeef", SECRET)) === "malformed",
    "an sha1 signature is malformed here rather than downgraded to",
  );
  check(
    reasonOf(verifyGithubSignature(body, `sha256=${"z".repeat(64)}`, SECRET)) === "malformed",
    "...and so is a non-hex digest, so the comparison never runs on attacker-chosen length",
  );
  check(
    reasonOf(verifyGithubSignature(body, "sha256=abc", SECRET)) === "malformed",
    "...and a short one, which is what would make timingSafeEqual throw",
  );

  // The bytes are what is signed, and a re-serialisation is not the bytes. This is the mistake
  // that passes every happy-path test and fails on real payloads.
  const spaced = '{"ref": "refs/heads/main"}';
  const tight = JSON.stringify(JSON.parse(spaced));
  check(
    spaced !== tight && !verifyGithubSignature(tight, sign(spaced), SECRET).ok,
    "a round-tripped body does not verify against the raw body's signature",
  );
  check(
    verifyGithubSignature(Buffer.from(spaced, "utf8"), sign(spaced), SECRET).ok,
    "...and the buffer the route actually reads does",
  );
}

console.log("\nwhat a delivery says happened");
{
  const push = parseWebhookEvent("push", {
    ref: "refs/heads/jaroku/weather",
    before: "1".repeat(40),
    after: "2".repeat(40),
    forced: false,
    repository: { full_name: "ada/weather" },
    sender: { login: "ada" },
    commits: [{ message: "Tighten the refund wording\n\nlong body" }, { message: "Fix a typo" }],
  }) as PushEvent;

  check(push.kind === "push", "a push is a push");
  check(push.repoFullName === "ada/weather" && push.branch === "jaroku/weather", "the repo and branch are read off it");
  check(push.headSha === "2".repeat(40) && push.beforeSha === "1".repeat(40), "and where the branch moved from and to");
  check(
    push.commitSubjects.join(" | ") === "Tighten the refund wording | Fix a typo",
    "subjects only, so the panel can say what moved without another API call",
  );
  check(push.senderLogin === "ada", "and who did it");

  // §6's row: a branch deleted under a live link. GitHub says so with a zero sha, and it becomes
  // the same null every other reader in this codebase already means by "the branch is not there".
  const deleted = parseWebhookEvent("push", {
    ref: "refs/heads/jaroku/weather",
    before: "1".repeat(40),
    after: "0".repeat(40),
    deleted: true,
    repository: { full_name: "ada/weather" },
  }) as PushEvent;
  check(deleted.headSha === null, "a deleted branch is a null head, not a sha of forty zeroes");
  check(deleted.beforeSha === "1".repeat(40), "...and still says where it had been");

  const created = parseWebhookEvent("push", {
    ref: "refs/heads/jaroku/weather",
    before: "0".repeat(40),
    after: "3".repeat(40),
    repository: { full_name: "ada/weather" },
  }) as PushEvent;
  check(created.beforeSha === null, "a created branch has no before, for the same reason");

  const forced = parseWebhookEvent("push", {
    ref: "refs/heads/jaroku/weather",
    after: "4".repeat(40),
    forced: true,
    repository: { full_name: "ada/weather" },
  }) as PushEvent;
  check(forced.forced, "a force-push is flagged — though the verdict still decides from a compare");
}

console.log("\nwhat is deliberately not acted on");
{
  // A tag push IS a push event, and read as a branch it would name a branch that does not exist —
  // which reads as §6's branch_missing on a repository where nothing is wrong.
  const tag = parseWebhookEvent("push", {
    ref: "refs/tags/v1.2.0",
    after: "5".repeat(40),
    repository: { full_name: "ada/weather" },
  });
  check(tag.kind === "ignored", "a tag push is ignored rather than parsed as a branch called v1.2.0");

  check(parseWebhookEvent("pull_request", {}).kind === "ignored", "an event this build does not handle is ignored");
  check(
    parseWebhookEvent("push", { ref: "refs/heads/main", after: "6".repeat(40) }).kind === "ignored",
    "a push with no repository names nothing and is ignored",
  );

  const ping = parseWebhookEvent("ping", { zen: "Non-blocking is better than blocking." });
  check(ping.kind === "ping", "ping is its own kind — answering it is what turns the hook green");
}

console.log("\nredelivery");
{
  const log = new DeliveryLog(3);
  check(log.admit("d1"), "a delivery is admitted once");
  check(!log.admit("d1"), "...and its retries are not, so one push is one broadcast");
  check(log.admit("d2") && log.admit("d3") && log.admit("d4"), "other deliveries are unaffected");
  // Bounded, so a long-lived process does not hold every delivery id it has ever seen.
  check(log.admit("d1"), "and the oldest falls out of a bounded log rather than growing forever");
  check(log.admit(undefined) && log.admit(undefined), "a delivery with no id is never deduped against another");
}

console.log("\nordering two deliveries");
{
  // The in-process log above catches a retry that reaches THIS process within its window. It cannot
  // survive a restart and cannot help a second replica — and GitHub does not guarantee ORDER at all,
  // which no dedup addresses. So the push carries its own clock, and the receiver refuses an older
  // observation over a newer one rather than taking whatever arrived last.
  const push = (over: Record<string, unknown>) =>
    parseWebhookEvent("push", {
      ref: "refs/heads/main",
      repository: { full_name: "acme/weather", pushed_at: 1_760_000_000 },
      after: "b".repeat(40),
      before: "a".repeat(40),
      commits: [],
      sender: { login: "riya" },
      ...over,
    });

  const withCommit = push({ head_commit: { timestamp: "2026-08-17T10:00:00Z" } });
  check(
    withCommit.kind === "push" && withCommit.pushedAt === "2026-08-17T10:00:00.000Z",
    "the commit's own timestamp is what orders a push",
    withCommit.kind === "push" ? String(withCommit.pushedAt) : withCommit.kind,
  );

  const noCommit = push({});
  check(
    noCommit.kind === "push" && noCommit.pushedAt === new Date(1_760_000_000_000).toISOString(),
    "...falling back to the repository's pushed_at, which arrives as epoch seconds here",
    noCommit.kind === "push" ? String(noCommit.pushedAt) : noCommit.kind,
  );

  const deleted = push({ after: "0".repeat(40), repository: { full_name: "acme/weather" } });
  check(
    deleted.kind === "push" && deleted.pushedAt === null,
    "a branch deletion carries neither, and says so rather than inventing one",
    deleted.kind === "push" ? String(deleted.pushedAt) : deleted.kind,
  );
}

console.log("\n§B.1.3's approval, which had no delivery to arrive on");
{
  // THE HALF THAT MADE THE STATE UNREACHABLE. `providerModeFor` answers `paid` when
  // `approvedForThisSha`; that reads a `check_runs` row with `provider_mode = 'paid'`; and such a
  // row was only ever written by a run `providerModeFor` had already answered `paid` for. Nothing
  // outside that circle could enter it — so no external pull request had ever been approved, while
  // every one of them was posted a summary saying a collaborator could approve it.
  const delivery = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    action: "requested_action",
    repository: { full_name: "acme/agents" },
    check_run: { id: 4242, head_sha: "a".repeat(40) },
    requested_action: { identifier: APPROVE_SHA_ACTION },
    sender: { login: "maintainer" },
    ...over,
  });

  const event = parseWebhookEvent("check_run", delivery());
  check(event.kind === "check_run_action", "a requested action is parsed", event.kind);
  if (event.kind === "check_run_action") {
    check(event.requestedAction === APPROVE_SHA_ACTION, "...carrying the identifier we declared");
    check(event.headSha === "a".repeat(40), "...the commit it is an approval FOR — per sha, never per pull request");
    check(event.checkRunId === "4242", "...GitHub's own id for the check, as a string like every other id here");
    check(event.senderLogin === "maintainer", "...and who pressed it, to be checked against the repository rather than trusted");
  }

  // THE OTHER THREE ACTIONS ON THIS EVENT ARE OURS COMING BACK. `created` and `completed` are the
  // writes this server just made; acting on them would be a loop.
  for (const action of ["created", "completed", "rerequested"]) {
    const other = parseWebhookEvent("check_run", delivery({ action }));
    check(other.kind === "ignored", `check_run.${action} is ignored rather than acted on`, other.kind);
  }

  // AND A MALFORMED ONE IS IGNORED RATHER THAN GUESSED AT, for the reason the route's header gives:
  // this path is about to spend a workspace's provider balance on somebody else's code.
  check(parseWebhookEvent("check_run", delivery({ requested_action: {} })).kind === "ignored", "an action with no identifier is ignored");
  check(parseWebhookEvent("check_run", delivery({ check_run: { id: 1 } })).kind === "ignored", "...and one with no head sha");
  check(parseWebhookEvent("check_run", delivery({ repository: {} })).kind === "ignored", "...and one with no repository");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

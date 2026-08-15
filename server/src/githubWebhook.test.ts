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

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

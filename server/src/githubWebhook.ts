// What GitHub says happened, verified and reduced to something this server can act on.
//
// THE FEATURE THIS EXISTS FOR. Until now the panel learned that a branch had moved by ASKING, on
// panel open — so a teammate's push was invisible to everybody who did not happen to reopen the
// tab, and the badge was as old as the last time somebody looked. A webhook inverts that: GitHub
// tells us, once, at the moment it happens, and the ↓ arrives in a panel nobody touched.
//
// A PURE MODULE, deliberately. It takes bytes and headers and returns a verdict and a shape; it
// has no database, no relay and no clock. That is what makes the interesting half — a forged
// signature, a deleted branch, a force-push, a tag pretending to be a branch — assertable without
// a server, and it is the same split `githubApi.ts` and `githubPush.ts` already make.
//
// THREE PROPERTIES, AND THE FIRST IS THE ENTIRE SECURITY BOUNDARY.
//
//   1. THE SIGNATURE IS THE AUTHENTICATION. This endpoint is public by construction — GitHub
//      cannot present a bearer token and has no socket — so the HMAC is the only thing between
//      "GitHub says this branch moved" and "anybody who can reach the URL says so". It is checked
//      over the RAW BYTES, before anything parses them, with a constant-time comparison.
//
//   2. NO SECRET CONFIGURED IS A REFUSAL, NOT A BYPASS. `billing/stripe.ts` settled this argument
//      for the other webhook in this codebase and the reasoning transfers unchanged: a deployment
//      with no webhook secret verifies nothing rather than everything. An unsigned endpoint that
//      moves a workspace's sync state is a way for a stranger to tell somebody their agent is
//      behind, or — with the pull that invites — worse.
//
//   3. NOTHING HERE DECIDES WHOSE IT IS. The payload names a repository; it does not name a
//      workspace, and it must not be able to. The route resolves the repository against
//      `github_links` and gets back the links that actually point at it, each carrying the
//      workspace it belongs to. A payload that could nominate a tenant would be a payload that
//      could address another one.
//
// WHY NO TIMESTAMP TOLERANCE, when the Stripe verifier next door has one. Stripe signs a
// timestamp alongside the payload, so a five-minute window is enforceable and bounds replay.
// GitHub signs the body alone — there is nothing in the signature to compare a clock against, and
// inventing a window from `X-GitHub-Delivery` or a field inside the payload would be checking a
// number the attacker also controls. What bounds replay here instead is that the actions are
// idempotent: the route records a head sha it was told about, and being told twice writes the
// same sha twice. See the route for the delivery-id de-duplication that keeps that cheap.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The header GitHub signs with. SHA-1 (`x-hub-signature`) exists and is deliberately not read. */
export const SIGNATURE_HEADER = "x-hub-signature-256";
/** GitHub's per-delivery uuid. Retries of one delivery reuse it, which is what makes dedup work. */
export const DELIVERY_HEADER = "x-github-delivery";
/** Which event this is: `push`, `ping`, `pull_request`, … */
export const EVENT_HEADER = "x-github-event";

/** A branch head of all zeros. GitHub's way of saying the ref no longer points anywhere. */
const ZERO_SHA = "0000000000000000000000000000000000000000";

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing" | "malformed" | "mismatch" };

/**
 * Whether these bytes came from something holding the shared secret.
 *
 * THE RAW BODY AND NOT A RE-SERIALISATION, which is the one way to get this wrong that still
 * passes a happy-path test: `JSON.parse` then `JSON.stringify` is free to reorder keys, reformat
 * numbers and drop whitespace, so a verifier fed a round-tripped body rejects payloads that are
 * perfectly genuine. The route reads `req.buffer()` and parses only after this returns ok.
 */
export function verifyGithubSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string | undefined,
): SignatureVerdict {
  if (!secret) return { ok: false, reason: "not_configured" };
  if (!header) return { ok: false, reason: "missing" };
  // `sha256=` and 64 hex characters. Anything else is not a thing GitHub sends, and being strict
  // here means the comparison below never runs on a length the attacker chose.
  const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();
  const given = Buffer.from(match[1]!, "hex");
  // Both are a SHA-256 digest, so the lengths are equal by construction — but compared anyway,
  // because `timingSafeEqual` throws on a mismatch rather than returning false, and a throw here
  // would be a 500 where a 401 belongs.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/** A branch on a repository moved, was created, or was deleted. */
export interface PushEvent {
  kind: "push";
  repoFullName: string;
  branch: string;
  /** Where the branch points now, or null when this push DELETED it — §6's own row. */
  headSha: string | null;
  /** Where it pointed before, or null when this push created it. */
  beforeSha: string | null;
  /**
   * Whether GitHub called this a force-push.
   *
   * Carried but never trusted as the whole answer. `syncVerdict` decides diverged from a
   * `compare`, because a rewrite can also arrive as an ordinary push on a branch somebody reset
   * and re-pushed in two steps — and a flag that is right most of the time is the worst kind of
   * input to a destructive decision.
   */
  forced: boolean;
  /** Message subjects, newest last. Enough to say WHAT moved without another API call. */
  commitSubjects: string[];
  senderLogin: string | null;
}

export type WebhookEvent =
  | PushEvent
  /** GitHub's setup handshake. Answered 200 or the delivery goes red in their UI forever. */
  | { kind: "ping"; zen: string | null }
  /** A real event this build does not act on yet. Named rather than dropped — see the route. */
  | { kind: "ignored"; event: string; reason: string };

/**
 * Reduce a delivery to the shape the rest of the server understands.
 *
 * TAGS AND EVERYTHING ELSE UNDER `refs/` ARE IGNORED RATHER THAN GUESSED AT. A push event fires
 * for tags too, and `ref` is `refs/tags/v1.2.0` — parsed as a branch name that would be a link
 * pointing at a branch called `v1.2.0` that does not exist, which reads as §6's branch_missing on
 * a repository where nothing is wrong at all.
 */
export function parseWebhookEvent(event: string, payload: Record<string, unknown>): WebhookEvent {
  if (event === "ping") {
    return { kind: "ping", zen: typeof payload["zen"] === "string" ? payload["zen"] : null };
  }
  if (event !== "push") return { kind: "ignored", event, reason: "not a push" };

  const ref = typeof payload["ref"] === "string" ? payload["ref"] : "";
  if (!ref.startsWith("refs/heads/")) {
    return { kind: "ignored", event, reason: `${ref || "an empty ref"} is not a branch` };
  }
  const repo = (payload["repository"] ?? {}) as Record<string, unknown>;
  const repoFullName = typeof repo["full_name"] === "string" ? repo["full_name"] : "";
  if (!repoFullName) return { kind: "ignored", event, reason: "no repository on the payload" };

  const after = typeof payload["after"] === "string" ? payload["after"] : "";
  const before = typeof payload["before"] === "string" ? payload["before"] : "";
  const commits = Array.isArray(payload["commits"]) ? payload["commits"] : [];
  const sender = (payload["sender"] ?? {}) as Record<string, unknown>;

  return {
    kind: "push",
    repoFullName,
    branch: ref.slice("refs/heads/".length),
    // DELETION IS A NULL HEAD RATHER THAN A ZERO SHA, so every caller downstream sees the same
    // "this branch does not exist" it would get from `refSha` — one shape for one fact, instead
    // of a magic string that has to be recognised in three places.
    headSha: after && after !== ZERO_SHA ? after : null,
    beforeSha: before && before !== ZERO_SHA ? before : null,
    forced: payload["forced"] === true,
    commitSubjects: commits
      .map((c) => {
        const message = (c as Record<string, unknown>)["message"];
        return typeof message === "string" ? (message.split("\n")[0] ?? "") : "";
      })
      .filter((s) => s.length > 0),
    senderLogin: typeof sender["login"] === "string" ? sender["login"] : null,
  };
}

/**
 * Deliveries already applied, so a retry is not a second broadcast.
 *
 * IN MEMORY AND BOUNDED, which is honest about what it defends against. GitHub delivers at least
 * once and retries on any non-2xx, so the same `X-GitHub-Delivery` can arrive several times in a
 * minute — and each one would otherwise re-broadcast a snapshot to every socket in the workspace.
 *
 * NOT A TABLE, and that is the difference from `billing_webhook_events`. Stripe's handler applies
 * a STATE TRANSITION — a plan change reapplied after a later one superseded it is a real defect,
 * so it needs a durable record that survives a restart and a second replica. This handler records
 * a head sha somebody else already decided; applying it twice writes the same value twice, and
 * the worst outcome of a missed dedup is a redundant broadcast. A migration to save a broadcast
 * would be paying a schema for a performance hint.
 */
export class DeliveryLog {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 500) {}

  /** True the first time a delivery id is offered, false every time after. Blank ids never dedup. */
  admit(deliveryId: string | undefined): boolean {
    if (!deliveryId) return true;
    if (this.seen.has(deliveryId)) return false;
    this.seen.add(deliveryId);
    this.order.push(deliveryId);
    if (this.order.length > this.limit) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }
}

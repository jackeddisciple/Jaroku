// POST /v1/github/webhook — the one GitHub surface that is not a socket command.
//
// WHY THIS IS NOT IN THE SECRETS GROUP, when `POST /v1/github/connect` is. That route is in
// `http/secrets.ts` because it WRITES A CREDENTIAL and therefore has to inherit `guarded()` —
// capability, tenancy, a live elevation. This one is the opposite of guarded by construction:
// GitHub cannot present a bearer token, has no session and has no workspace, so putting it behind
// the same door would mean the door never opens. It belongs beside `POST /v1/billing/webhook`,
// which is unauthenticated for exactly the same reason and answers the same way.
//
// THE SIGNATURE IS THE AUTHENTICATION and it is checked in `githubWebhook.ts` over the RAW BYTES
// before anything here parses them. Everything below this line assumes that already happened.
//
// WHAT A DELIVERY IS ALLOWED TO ESTABLISH, and it is worth stating as a bound rather than as a
// list of features: that a named repository's named branch now points at a named sha. That is
// all. It does not choose a workspace — the repository name is matched against `github_links` and
// the rows come back carrying whose they are. It does not move `last_pushed_sha`, because that
// column is what Jaroku HAS and a webhook is somebody else's news. It does not pull, it does not
// push, and it does not decide a verdict: it records what was seen and re-broadcasts, and
// `syncVerdict` reaches its own conclusion from columns it already trusted.
//
// ALWAYS 2xx ONCE THE SIGNATURE PASSES. GitHub retries any non-2xx and disables a hook that keeps
// failing, so a handler that 500'd on one malformed payload would eventually take the whole
// integration down for every workspace. A delivery this build does not act on is `ignored` and
// says so in the body; a delivery that blows up is logged and still acknowledged, because the
// retry would blow up identically.

import { badRequest, unauthorized, type Handler, type HttpRequest, type HttpResponse } from "./router.ts";
import {
  DELIVERY_HEADER, DeliveryLog, EVENT_HEADER, SIGNATURE_HEADER,
  parseWebhookEvent, verifyGithubSignature, type PushEvent,
} from "../githubWebhook.ts";
import type { GithubRepository, LinkOwner } from "../db/repositories/github.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";

export interface GithubWebhookDeps {
  repo: GithubRepository;
  /** The shared secret, read per request so a rotation does not need a restart. */
  secret: () => string | undefined;
  /**
   * Tell one workspace its GitHub state moved.
   *
   * A callback rather than the relay itself, for the reason `billingRoutes.notify` is one: this
   * module resolves a delivery to a set of workspaces and should not also know how a workspace is
   * reached. It is optional so the suite can run the whole path with nothing listening.
   */
  notify?: (ctx: TenantContext, agentId: string) => void;
  log?: (line: string) => void;
}

export function githubWebhookRoutes(
  deps: GithubWebhookDeps,
): { path: string; method: "POST"; handler: Handler }[] {
  return [{ path: "/v1/github/webhook", method: "POST", handler: webhookHandler(deps) }];
}

function webhookHandler(deps: GithubWebhookDeps): Handler {
  const log = deps.log ?? ((line: string) => console.log(line));
  // One log per process. Retries of a delivery arrive within seconds of each other, so this is
  // sized for a burst rather than for history — see DeliveryLog for why it is not a table.
  const delivered = new DeliveryLog();

  return async (req: HttpRequest): Promise<HttpResponse> => {
    // RAW FIRST. A signature is over the bytes that were sent, and `JSON.parse` followed by
    // `JSON.stringify` does not reproduce them.
    const raw = await req.buffer();
    const verdict = verifyGithubSignature(raw, req.header(SIGNATURE_HEADER), deps.secret());
    if (!verdict.ok) {
      // The REASON is logged and never returned. "not_configured" tells an unauthenticated caller
      // that this deployment has no secret set, which is the one fact that would tell them the
      // endpoint is worth attacking; every refusal looks identical from outside.
      log(`[github] webhook rejected (${verdict.reason})`);
      throw unauthorized("bad signature");
    }

    const deliveryId = req.header(DELIVERY_HEADER);
    if (!delivered.admit(deliveryId)) {
      return { status: 200, body: { ok: true, applied: false, reason: "already delivered" } };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      // Signed and unparseable is not a retry candidate: the same bytes will fail the same way.
      throw badRequest("body is not JSON");
    }

    const event = parseWebhookEvent(req.header(EVENT_HEADER) ?? "", payload);
    if (event.kind === "ping") {
      log(`[github] webhook ping accepted`);
      return { status: 200, body: { ok: true, pong: true } };
    }
    if (event.kind === "ignored") {
      return { status: 200, body: { ok: true, applied: false, reason: event.reason } };
    }

    try {
      const applied = await applyPush(deps, event, log);
      return { status: 200, body: { ok: true, applied } };
    } catch (err) {
      // ACKNOWLEDGED ANYWAY. See the header: a non-2xx is a retry, and a retry of a delivery that
      // just threw will throw again — the only thing a 500 buys is GitHub eventually disabling
      // the hook for every workspace that shares it.
      log(`[github] webhook ${event.repoFullName}:${event.branch} failed: ${(err as Error)?.message ?? err}`);
      return { status: 200, body: { ok: true, applied: 0, error: "handler failed" } };
    }
  };
}

/**
 * Record what a push told us, for every workspace that linked that repository and branch.
 *
 * ONE WORKSPACE AT A TIME, each through its own context, so every write below is an ordinary
 * tenant-scoped statement. The cross-workspace read is the lookup and nothing else.
 */
async function applyPush(
  deps: GithubWebhookDeps,
  event: PushEvent,
  log: (line: string) => void,
): Promise<number> {
  const owners: LinkOwner[] = await deps.repo.linksForRepo(event.repoFullName, event.branch);
  if (owners.length === 0) return 0;

  for (const { workspaceId, link } of owners) {
    // A SYSTEM CONTEXT, because there is no user here and pretending otherwise would put a name
    // in `actor_user_id` that did not do this. The push belongs to whoever GitHub says sent it,
    // and that is a login rather than a Jaroku account.
    const ctx = systemContextFor(workspaceId, newRequestId());
    await deps.repo.patchLink(ctx, link.id, {
      // WHAT WE HAVE SEEN, NEVER WHAT WE HAVE. `last_pushed_sha` is untouched on purpose: it is
      // the commit Jaroku itself put there, it is what `syncVerdict` measures behind against, and
      // a webhook writing it would tell the panel that somebody else's commit was ours — which is
      // the shape of the bug that made `behind` unreachable in the first place.
      lastKnownRemoteSha: event.headSha,
      lastSyncedAt: new Date().toISOString(),
    });
    // Recorded as a `fetch`, which is what it is: the remote was observed to have moved, and
    // nothing was pushed or pulled. The detail names the sender and the head, so the History row
    // answers "what moved and who moved it" without another call.
    await deps.repo.record(ctx, {
      agentId: link.agent_id,
      linkId: link.id,
      kind: "fetch",
      commitSha: event.headSha,
      detail: describe(event),
    });
    deps.notify?.(ctx, link.agent_id);
  }

  log(
    `[github] webhook ${event.repoFullName}:${event.branch} -> ` +
      `${event.headSha ? event.headSha.slice(0, 7) : "deleted"} (${owners.length} link${owners.length === 1 ? "" : "s"})`,
  );
  return owners.length;
}

/** One sentence for the History row. Names the case rather than dumping the payload. */
function describe(event: PushEvent): string {
  const who = event.senderLogin ? ` by @${event.senderLogin}` : "";
  if (event.headSha === null) return `branch deleted on GitHub${who}`;
  if (event.beforeSha === null) return `branch created on GitHub${who}`;
  const head = event.commitSubjects[event.commitSubjects.length - 1] ?? event.headSha.slice(0, 7);
  const more = event.commitSubjects.length > 1 ? ` (+${event.commitSubjects.length - 1} more)` : "";
  return `${event.forced ? "force-pushed" : "pushed"}${who}: ${head}${more}`;
}

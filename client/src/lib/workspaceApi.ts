// Taking everything with you, and taking it away.
//
// Both are HTTP rather than socket commands, and the server states why: what an export produces is
// a FILE a browser downloads, and a download is a request with a URL. Putting either on the socket
// would mean inventing a way to hand a browser a link over a frame.
//
// THE EXPORT IS ASYNCHRONOUS AND THE STATUS CHECK IS STATELESS. `POST` enqueues and answers 202
// with an id; the worker writes an archive at a key derived from that id; `GET` asks the object
// store whether the key exists. So there is no job table to reconcile, a replica that has never
// heard of the job answers correctly, and a worker that died mid-export leaves no object and
// therefore no false "ready".
//
// WHICH IS ALSO WHY POLLING IS THE CLIENT'S JOB. There is nothing to push: no row changes state,
// and the socket has no channel for it. A poll every few seconds against a HEAD on one key is the
// cheapest correct answer available.

import { apiRequest } from "./http.ts";

export interface ExportStarted {
  exportId: string;
  status: "pending";
  /** Where to look. From the server, so no client hardcodes a second copy of the route's shape. */
  statusUrl: string;
}

export type ExportStatus =
  | { exportId: string; status: "pending" }
  | {
      exportId: string;
      status: "ready";
      bytes: number;
      generatedAt: string;
      url: string;
      /** Stated by the server rather than inferred: the local store's URL carries no expiry. */
      expiresAt: string;
    };

/** Ask for a copy of everything. Answers immediately; the archive is written by a worker. */
export async function startWorkspaceExport(): Promise<ExportStarted> {
  return apiRequest<ExportStarted>("POST", "/v1/workspace/export");
}

/**
 * Whether that archive is there yet.
 *
 * The id goes in the path and the WORKSPACE comes from this tab's session, which is what makes a
 * leaked export id useless: the server builds the object key from the context's workspace, so an
 * id from somewhere else resolves to a key that does not exist.
 */
export async function workspaceExportStatus(exportId: string): Promise<ExportStatus> {
  return apiRequest<ExportStatus>("GET", `/v1/workspace/export/${encodeURIComponent(exportId)}`);
}

export interface DeletionReceipt {
  /** Rows, objects, checkpoints, queued work — whatever the server counted. */
  [key: string]: unknown;
}

/**
 * Destroy the workspace and everything of it.
 *
 * `confirm` MUST BE THE WORKSPACE'S OWN ID and the server checks it. Every other destructive action
 * in the product is reversible — an undo is a version pointer, a suspension is a row somebody lifts
 * — and this one is not, so the body carrying the id is the cheapest possible proof that the caller
 * knows which workspace they are about to lose.
 *
 * The answer is a RECEIPT rather than a 204: somebody asked for their data to be destroyed and is
 * entitled to the count of what was, including whatever could not be revoked at a third party —
 * which is the part a silent success would hide.
 */
export async function deleteWorkspace(confirm: string): Promise<DeletionReceipt> {
  return apiRequest<DeletionReceipt>("POST", "/v1/workspace/delete", { confirm });
}

/**
 * Start a checkout for a plan, and answer with the URL the browser has to go to.
 *
 * NOT A SOCKET COMMAND, and the server says why: the answer is a redirect target for a third-party
 * payment form, and putting it on the trace channel would mean the client had to hold "am I
 * mid-checkout" across a reconnect.
 *
 * THE WORKSPACE GOES IN THE BODY, not only on the query string, because this route resolves its
 * tenant from the body — through the same membership resolver `/v1/ws-ticket` uses, which for a
 * route that starts a PAYMENT matters more than for one that opens a socket. `apiRequest` adds the
 * query parameter as well; the route ignores it, and sending both is cheaper than a second helper.
 *
 * The PRICE is never sent. It comes from the `plans` table server-side — a price id in a request
 * body would let somebody subscribe to whatever they could name.
 */
export async function startCheckout(
  plan: string,
  workspaceId: string,
  seats?: number,
): Promise<{ url: string }> {
  return apiRequest<{ url: string }>("POST", "/v1/billing/checkout", { plan, workspaceId, seats });
}

/** What the server believes about this workspace's subscription. See `fetchSubscription`. */
export interface SubscriptionView {
  /** What every limit is read from. Not the same fact as the provider's status — see below. */
  tier: string;
  entitled: boolean;
  subscription: {
    status: string;
    seatCount: number;
    byokEnabled: boolean;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    attention: boolean;
  } | null;
}

/**
 * What this workspace's subscription actually is, right now.
 *
 * THE AUTHORITATIVE ANSWER AFTER A CHECKOUT, and the reason the upgrade flow polls it rather than
 * trusting what it has. Coming back from the system browser, the app knows only that a deep link
 * arrived — not whether the webhook has landed, and not whether the person actually paid. So it
 * asks here until the answer settles, and says "confirming your subscription" until it does.
 *
 * TWO FACTS, DELIBERATELY SEPARATE. `tier` is what this system believes and what every limit is
 * read from; `subscription.status` is what the payment provider believes. A workspace whose card
 * failed on Tuesday is `past_due` AND still on Pro, and a screen that had to pick one of those
 * would be wrong about the other.
 */
export async function fetchSubscription(workspaceId: string): Promise<SubscriptionView> {
  return apiRequest<SubscriptionView>(
    "GET",
    `/v1/billing/subscription?workspace=${encodeURIComponent(workspaceId)}`,
    undefined,
    // The workspace is already on the path; `apiRequest` would append a second copy of it.
    { scoped: false },
  );
}

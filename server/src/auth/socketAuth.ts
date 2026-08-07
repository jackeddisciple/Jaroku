// What the relay calls to decide whether a socket may exist, and in which workspace.
//
// This is the line Session 1's `devTenancy.ts` said Session 2 would replace, and its comment
// was right about what would change: the SHAPE stays exactly as it was — a connection arrives,
// a workspace is resolved for it, everything downstream takes that context as a parameter —
// and only the resolution becomes real.
//
// THE TICKET IS THE WHOLE CREDENTIAL. There is no fallback to a header, no cookie, no
// "workspace" query parameter, and no path where a value from the URL becomes a workspace id
// without a `ws_tickets` row being redeemed for it. A ticket was minted by an authenticated
// HTTP request that passed a membership check, is single-use, and is worth nothing after
// thirty seconds — so a socket's scope was decided by a `workspace_members` row, one round
// trip ago, and cannot be argued with afterwards.
//
// THE ESCAPE HATCH IS REAL, LOUD, AND CANNOT REACH PRODUCTION. `JAROKU_DEV_AUTH=1` opens a
// socket with no credential at all, in the workspace `JAROKU_DEV_WORKSPACE` names. It exists
// because plenty of local tooling — a `wscat`, a script, a half-written client — has no idea
// what a ticket is, and because the fallback debug client used to be one line of JavaScript.
// It announces itself at boot, on every refused-then-allowed connection, and `resolveSocketAuth`
// throws rather than starting when `NODE_ENV=production`.
//
// It is deliberately NOT the default in development. The local issuer (see config.ts) means a
// developer already has real authentication with no cloud account, so the path exercised every
// day is the path that runs in production — and an escape hatch that is on by default is
// exercised instead of the thing it bypasses.

import { UpgradeRefused, type SocketSession } from "../wsRelay.ts";
import type { IncomingMessage } from "node:http";
import { newRequestId, type Role, type TenantContext } from "../db/tenant.ts";
import type { TicketStore } from "./tickets.ts";

export const DEV_AUTH_ENV = "JAROKU_DEV_AUTH";

export interface SocketAuthOptions {
  tickets: TicketStore;
  /** The context the escape hatch hands out. Session 1's dev workspace, unchanged. */
  devContext: () => TenantContext;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
}

/**
 * Build the relay's authoriser.
 *
 * Throwing `UpgradeRefused` is how it says no; the relay turns that into an HTTP status on the
 * raw socket, before the handshake, so a client can tell "you are not allowed" from "the
 * network dropped" — which is the difference between showing a sign-in screen and retrying
 * forever.
 */
export function resolveSocketAuth(opts: SocketAuthOptions): (req: IncomingMessage) => Promise<SocketSession> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const devAuth = env[DEV_AUTH_ENV] === "1";

  if (devAuth && env["NODE_ENV"] === "production") {
    throw new Error(
      `${DEV_AUTH_ENV}=1 opens sockets with no credential at all. It refuses to run under ` +
        `NODE_ENV=production — unset it, and let clients present a ticket from /v1/ws-ticket.`,
    );
  }
  if (devAuth) {
    log(
      `[auth] ${DEV_AUTH_ENV}=1 — ANY socket may connect with no ticket and no token, in the ` +
        `dev workspace. Development only; it refuses to start under NODE_ENV=production.`,
    );
  }

  return async (req: IncomingMessage): Promise<SocketSession> => {
    const raw = ticketFrom(req);
    if (!raw) {
      if (devAuth) return { context: opts.devContext(), expiresAt: null };
      throw new UpgradeRefused(401, "open this socket with a ticket from POST /v1/ws-ticket");
    }

    const redeemed = await opts.tickets.consume(raw);
    if (!redeemed) {
      // One message for expired, spent, forged and never-issued. They are all "get another
      // one", and distinguishing them would tell somebody holding a stolen ticket whether it
      // was ever real.
      throw new UpgradeRefused(401, "that ticket has expired or has already been used");
    }

    return {
      context: {
        workspaceId: redeemed.workspaceId,
        actorUserId: redeemed.userId,
        role: redeemed.role as Role,
        // A fresh id per connection: everything this socket does correlates to the connection
        // rather than to the HTTP request that happened to mint its ticket.
        requestId: newRequestId(),
      },
      // Unix seconds, from the token that bought this ticket. The relay's revalidation timer
      // is the only reader: a socket whose credential has run out is closed rather than left
      // to live until somebody closes the tab.
      expiresAt: redeemed.tokenExpiresAt,
      userId: redeemed.userId,
    };
  };
}

/**
 * The ticket, from the query string, which is the only place a browser can put one.
 *
 * Read from `req.url` rather than a parsed object because at upgrade time there is no router
 * involved — this is the raw HTTP request the socket is being built from. The value is never
 * logged: the router's redaction list names `ticket` for exactly this reason.
 */
function ticketFrom(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const value = url.searchParams.get("ticket");
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

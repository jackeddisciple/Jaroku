// Which network interfaces this server answers on, which is a security decision and was a default.
//
// `server.listen(port)` WITH NO HOST BINDS EVERY INTERFACE. That is Node's documented behaviour —
// the handle is opened on `::` with dual-stack, so it answers on loopback, on the LAN address, and
// on anything else the machine has — and it is the wrong default for the way most of this product
// actually runs.
//
// WHAT IT COSTS ON A DESKTOP INSTALL, concretely, because this is not a hardening abstraction. A
// desktop install runs the LOCAL ISSUER, and the local issuer mounts `POST /v1/auth/dev-login`:
// hand it an email address, get back a real session token for that account, no password at any
// point. Bound to every interface, that route is reachable from every other device on the same
// network. On a café or office or co-working Wi-Fi, anybody who can reach port 4317 can sign in as
// the person sitting across the room and read every thread, trace and credential in their
// workspace. `GET /v1/auth/methods` advertises it — it answers `"localIssuer": true` — so it does
// not even have to be guessed at.
//
// SO THE DEFAULT IS LOOPBACK, AND A HOSTED DEPLOYMENT SAYS OTHERWISE ON PURPOSE. That is the right
// way round for a setting like this: the failure of defaulting to loopback is a hosted deploy that
// cannot be reached, which is discovered in seconds and fixed in one line, while the failure of
// defaulting to every interface is invisible on the machine it is wrong on and is discovered by
// somebody else.
//
//   npm run test:bind-host

/** The one environment variable this module reads. */
export const BIND_HOST_ENV = "JAROKU_BIND_HOST";

/**
 * IPv4 loopback rather than `localhost`, deliberately.
 *
 * `localhost` is a NAME, and what it resolves to is the machine's business — on a host whose
 * `/etc/hosts` maps it to something else, or where IPv6 resolution wins and the client is asking
 * over IPv4, "bind localhost" is a bind to an address nobody can predict. An address is an address.
 */
export const LOOPBACK = "127.0.0.1";

/** What a container has to bind for anything outside it to connect. */
export const ALL_INTERFACES = "0.0.0.0";

/**
 * Resolve the bind address.
 *
 * THE PRODUCTION DEFAULT IS EVERY INTERFACE and that is not a contradiction of the header. A
 * container's port is published by the platform in front of it — Fly, a Kubernetes service, a
 * Docker `-p` — and a process that bound loopback inside one is a process nothing can route to. The
 * exposure that matters there is the platform's, and `NODE_ENV=production` already refuses to start
 * without `JAROKU_ALLOWED_ORIGINS` and the rest of the hosted configuration.
 *
 * The case this protects is the one that has no platform in front of it: a desktop install, and a
 * developer's `npm run dev`. Neither is `NODE_ENV=production`, and neither should be answering the
 * network.
 */
export function resolveBindHost(
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = console.log,
): string {
  const configured = (env[BIND_HOST_ENV] ?? "").trim();
  const production = env["NODE_ENV"] === "production";

  if (configured) {
    // Said out loud whichever way it goes: this is the line somebody will be looking for when they
    // are trying to work out why the server is or is not reachable from another machine.
    if (!isLoopback(configured)) {
      log(
        `[auth] ${BIND_HOST_ENV}=${configured} — this server answers on a non-loopback interface. ` +
          `Every route it serves is reachable from the network.`,
      );
    } else {
      log(`[auth] binding ${configured} — this machine only.`);
    }
    return configured;
  }

  if (production) {
    log(`[auth] binding ${ALL_INTERFACES} (NODE_ENV=production) — the platform in front publishes the port.`);
    return ALL_INTERFACES;
  }

  log(
    `[auth] binding ${LOOPBACK} — this machine only. The local issuer can mint a session for any ` +
      `account with no password, so this port must not answer the network. Set ${BIND_HOST_ENV} to ` +
      `override.`,
  );
  return LOOPBACK;
}

/**
 * Whether an address is a loopback one.
 *
 * Exported because two callers need the same answer and a second spelling of "is this safe" is how
 * one of them starts disagreeing. `::ffff:127.0.0.1` is the IPv4-mapped form a dual-stack socket
 * reports and is the same interface by another name.
 */
export function isLoopback(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost") return true;
  if (value === "::1") return true;
  if (value === "::ffff:127.0.0.1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1 — 127.0.0.2 is equally the local machine, and
  // an allowlist of one address would call it external.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

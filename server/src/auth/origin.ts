// The Origin check on a WebSocket upgrade, which is not optional.
//
// WEBSOCKETS ARE NOT COVERED BY CORS. This surprises people, and the surprise is the whole
// vulnerability. A browser will not let `evil.example` read a cross-origin `fetch` response
// without the server's permission — but `new WebSocket("wss://jaroku.example/ws")` from a page
// on `evil.example` connects, carries the user's cookies, and the response is not subject to
// any CORS check because the WebSocket handshake is not a CORS request. That is
// cross-site WebSocket hijacking, and the `Origin` header is the actual defence: browsers set
// it on every upgrade and script cannot forge it.
//
// This server's ticket is a second, independent defence — a page on another origin cannot read
// the response of the `POST /v1/ws-ticket` it would need to get one. Both are here because
// they fail differently: the ticket protects against an attacker who cannot make an
// authenticated cross-origin request, and the origin check protects against every future
// change that makes obtaining a ticket easier, including the cookie somebody will eventually
// want to add.
//
// A MISSING ORIGIN IS ALLOWED, and that is correct rather than a loophole. Browsers always
// send one; `curl`, the `ws` library, the test suites and the fallback debug client do not.
// Refusing a missing Origin would break every non-browser client while stopping no attack —
// an attacker with a non-browser client can send any Origin they like, so the header only ever
// means anything when it comes from a browser, and a browser always sends it. What stops the
// non-browser case is the ticket, which is a credential rather than a claim.

/** Where the Vite dev server lives, and the only origins a local install has. */
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4317",
  "http://127.0.0.1:4317",
];

export const ORIGIN_ENV = "JAROKU_ALLOWED_ORIGINS";

export interface OriginPolicy {
  /** Is this `Origin` header value allowed to open a socket? */
  allows(origin: string | undefined): boolean;
  /** For the boot log, so a misconfiguration is visible before somebody debugs a 403. */
  describe(): string;
}

/**
 * Build the policy from `JAROKU_ALLOWED_ORIGINS`, or refuse to guess.
 *
 * Unset in development means the local origins above. Unset in PRODUCTION is a configuration
 * that has not been made — and the failure mode of guessing there is either "nothing can
 * connect" or "anything can", so it refuses to start instead of picking one.
 */
export function resolveOriginPolicy(
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = console.log,
): OriginPolicy {
  const configured = (env[ORIGIN_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const production = env["NODE_ENV"] === "production";

  if (configured.length === 0 && production) {
    throw new Error(
      `${ORIGIN_ENV} is not set. WebSockets are not covered by CORS, so the origin allowlist ` +
        `is the cross-site-hijacking defence and there is no safe default for it.`,
    );
  }

  const allowed = new Set((configured.length ? configured : DEV_ORIGINS).map(normalise));
  if (allowed.has("*")) {
    // Allowed, because somebody may genuinely be fronting this with a gateway that has already
    // decided. Loud, because it is the one setting here that turns the defence off.
    log(`[auth] ${ORIGIN_ENV} is "*" — EVERY origin may open a socket. The ticket is the only wall left.`);
  } else if (configured.length === 0) {
    log(`[auth] origin allowlist (development default): ${[...allowed].join(", ")}`);
  } else {
    log(`[auth] origin allowlist: ${[...allowed].join(", ")}`);
  }

  return {
    allows(origin) {
      // See the header comment: absent means not a browser, and the ticket is what holds.
      if (origin === undefined || origin === "") return true;
      if (allowed.has("*")) return true;
      // `null` is what a sandboxed iframe or a `file://` page sends. It is a real value meaning
      // "an opaque origin", and an opaque origin is exactly the one that must not be trusted.
      if (origin === "null") return false;
      return allowed.has(normalise(origin));
    },
    describe: () => [...allowed].join(", "),
  };
}

/**
 * Compare origins as origins, not as strings.
 *
 * `https://app.example` and `https://app.example/` and `https://APP.example` are the same
 * origin, and an allowlist that misses that is one somebody "fixes" by adding a wildcard.
 * A default port is dropped for the same reason.
 */
function normalise(value: string): string {
  if (value === "*") return "*";
  try {
    const url = new URL(value);
    const port =
      (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")
        ? ""
        : url.port;
    return `${url.protocol}//${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`;
  } catch {
    // Not a URL. Kept verbatim so it can never accidentally match something that is.
    return value.toLowerCase();
  }
}

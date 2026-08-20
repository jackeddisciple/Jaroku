// Configuration a HOST can hand this bundle at runtime, before a line of it has run.
//
// WHAT THIS IS FOR, AND WHY IT IS NOT A TAURI MODULE. `VITE_JAROKU_WS` is a BUILD-time constant.
// That is the right shape for a deployment, where the relay's address is decided once and baked
// in — and the wrong shape for exactly one fact the desktop shell knows and the build cannot:
// which port the backend actually got. 4317 is the default and stays the default, but a
// developer with a terminal and the app open at once has it taken, the shell resolves the next
// free one, and a bundle carrying `ws://localhost:4317` would spend that session failing to
// connect to a backend that is running perfectly well one port up.
//
// So the host writes the answer onto the global object before the bundle loads, and this module
// reads it. Nothing here mentions Tauri, imports from it or branches on it: a host is anything
// that can run a script first — the desktop shell today, an Electron shim or a kiosk wrapper
// tomorrow — and this module cannot tell which one set the value. That is deliberate. The two
// places this app genuinely knows it is inside Tauri are the session vault and the deep-link
// listener, and both of them say so in their own file; a third would be one too many.
//
// EVERYTHING IS VALIDATED ON THE WAY OUT, for the reason `activityRange.ts` gives about
// `localStorage`: a value from outside this module's control is untrusted input. Here the
// untrusted part is not malice — the host is the application — it is a HOST THAT IS WRONG: a
// stale injection, a shim that set the field to a number, a future host that spells it
// `ws_url`. Every one of those has to read as "no host configuration" rather than as a URL,
// because falling through to the build-time default is a working app and a malformed socket URL
// is a blank screen.

/** The shape a host writes. One field today; an object rather than a bare string so a second
 *  one does not need a second global with its own name to get wrong. */
interface HostConfig {
  wsUrl?: unknown;
}

function host(): HostConfig | undefined {
  // `globalThis` rather than `window`, because every suite in this repository runs under tsx,
  // where `window` is not defined and reading it throws at module load — the same trap
  // `auth.ts`'s `viteEnv` exists to avoid with `import.meta.env`.
  const value = (globalThis as { __JAROKU_CONFIG__?: unknown }).__JAROKU_CONFIG__;
  return typeof value === "object" && value !== null ? (value as HostConfig) : undefined;
}

/**
 * The WebSocket origin the host wants this client to use, or `undefined` for "there is no host,
 * or it did not say".
 *
 * Only `ws://` and `wss://` are accepted, and only a URL the platform's own parser agrees is
 * one. A host that offered `http://…` here would be a host that had confused the two variables,
 * and quietly rewriting the scheme for it would hide the mistake in the one place — a socket
 * that never opens — where it is hardest to see.
 */
export function hostWsUrl(): string | undefined {
  const raw = host()?.wsUrl;
  if (typeof raw !== "string" || raw === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined;
  // Trailing slashes are stripped here rather than at each of the two call sites, which is where
  // the duplication that this module replaces had already produced two slightly different
  // spellings of the same normalisation.
  return raw.replace(/\/+$/, "");
}

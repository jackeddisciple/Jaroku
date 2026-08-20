// Where the session token lives, in whichever of the two places this bundle is running.
//
// THE PROBLEM THIS SOLVES IS SHAPE, NOT STORAGE. `auth.ts`'s four accessors are synchronous and
// have to stay that way: `storedToken()` is called from `socket.ts` while deciding whether to
// connect, from `http.ts` while building a header, and from `sessionStore`'s bootstrap. Every
// operating-system credential store is asynchronous. Turning four functions into promises would
// mean touching every one of those call sites and every one above them, in a codebase whose rule
// for this work is that the wrapper adapts to Jaroku.
//
// SO: an in-memory cache with a synchronous face, filled once before the app renders and written
// through afterwards. `hydrate()` is the only asynchronous thing here, it is awaited in
// `main.tsx` before the first render, and in a browser it resolves without doing anything at all
// because `localStorage` is already synchronous. That is the whole design.
//
// TWO BACKENDS, CHOSEN ONCE, NEVER MIXED:
//
//   A BROWSER — `localStorage`, byte for byte what this client has always done. `npm run dev` is
//   unchanged, `test:auth` still passes against the same behaviour, and `test:reset`'s sweep of
//   `jaroku.*` keys still finds and clears the same two.
//
//   A HOST WITH A CREDENTIAL STORE — the Keychain, Credential Manager or Secret Service, through
//   `src-tauri/src/secrets.rs`. `localStorage` is NOT written in this mode, not as a mirror and
//   not as a fallback: a mirror is a copy of the token in the place the credential store exists
//   to move it out of, which would leave the protection notional while making it look real.
//
//   AND WHERE THE STORE IS UNAVAILABLE — a Linux session with no Secret Service, a locked
//   keychain — the cache alone. The session then lasts as long as the window does and a relaunch
//   asks for sign-in again. That is a real cost and it is the correct one: the alternative is
//   writing the token to a plain file, which is the thing being avoided.
//
// THE KEYS ARE THE CALLER'S. Nothing here spells `jaroku.token`; `auth.ts` owns those literals
// and always has, and keeping it that way means this module adds no new browser-storage key for
// `test:reset` to find unclassified.

type Backend = "browser" | "host";

interface TauriBridge {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

function bridge(): TauriBridge | undefined {
  return (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
}

/** Resolved per call rather than cached at module load. A module-level constant would be
 *  evaluated before the host has finished installing its bridge in some load orders, and the
 *  answer would then be wrong for the life of the page. */
function backend(): Backend {
  return bridge()?.core?.invoke ? "host" : "browser";
}

/** The host-backed cache. Empty and unused in a browser, where `localStorage` is the truth. */
const cache = new Map<string, string>();
let hydrated = false;

/**
 * Fill the cache from the credential store. Resolves immediately in a browser.
 *
 * EVERY KEY IS ASKED FOR IN PARALLEL and a failure on one does not stop the others: the two keys
 * are independent, and a workspace id that could not be read should not cost somebody their
 * token. `hydrated` is set whatever happened, because the alternative — retrying — would mean the
 * app rendering against an empty cache while a retry was in flight, which is a sign-in screen
 * that appears and then disappears.
 */
export async function hydrate(keys: readonly string[]): Promise<void> {
  if (backend() === "browser" || hydrated) {
    hydrated = true;
    return;
  }
  const invoke = bridge()!.core!.invoke;
  await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await invoke("secret_get", { key });
        if (typeof value === "string") cache.set(key, value);
      } catch {
        // See the header: an unavailable store is indistinguishable from an empty one for every
        // purpose this client has, and both mean "there is no session to resume".
      }
    }),
  );
  hydrated = true;
}

/** Read a value. Synchronous in both modes, which is the entire point of this module. */
export function read(key: string): string | null {
  if (backend() === "host") return cache.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. Not fatal: the session lives in memory for as long
    // as the tab does, and a reload asks again. This is `auth.ts`'s own behaviour, moved.
    return null;
  }
}

/**
 * Write a value, or remove it when `null`.
 *
 * THE CACHE IS UPDATED FIRST AND SYNCHRONOUSLY, then the store is told. Waiting for the store
 * would make this asynchronous, which is what the whole module exists to avoid — and the order
 * matters beyond that: `socket.ts` stores a token and immediately reads it back to open a socket,
 * so a write that only became visible after a round trip would be a sign-in that does not connect
 * until the second attempt.
 *
 * The round trip's failure is logged and not surfaced. There is nothing a user can do about a
 * keychain that will not write, and the consequence — a session that does not survive a
 * relaunch — announces itself.
 */
export function write(key: string, value: string | null): void {
  if (backend() === "host") {
    const invoke = bridge()!.core!.invoke;
    if (value === null) {
      cache.delete(key);
      void invoke("secret_delete", { key }).catch(report);
    } else {
      cache.set(key, value);
      void invoke("secret_set", { key, value }).catch(report);
    }
    return;
  }
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* see read() */
  }
}

function report(err: unknown): void {
  // The KEY is named and the value never is — the same rule every log sink in this product
  // follows, and the reason `protectEnv` exists on the server side.
  console.warn(`[jaroku] the credential store refused a write: ${String(err)}`);
}

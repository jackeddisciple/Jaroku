// `jaroku://` links, as the page sees them.
//
// THE PARSER IS HERE AND NOT IN RUST, and that is the load-bearing decision in this file. The
// shell's job is to receive a URL from the operating system and hand it over; deciding what one
// MEANS is a decision about this application's own routes and sessions, and it belongs where the
// routes and the session are. It also belongs where it can be tested: a rule living in the
// desktop shell can only be exercised by building and launching a desktop app, and a rule that
// can only be exercised that way is a rule nobody exercises.
//
// EVERY URL THAT ARRIVES HERE IS UNTRUSTED INPUT. It was not produced by this application. Any
// program on the machine can open a `jaroku://` URL, and so can a web page the user clicked on,
// which is the same posture `activityRange.ts` takes towards `localStorage` and for a stronger
// reason. So: the scheme is checked rather than assumed, the action is matched against a list
// rather than dispatched by name, parameters are read individually rather than spread, and
// anything unrecognised produces `null` rather than a partially-understood object. A link that
// half-parses is worse than one that does not parse at all.
//
// WHAT IS DELIBERATELY NOT HERE: what to DO about a link. Redeeming a magic link and finishing an
// OAuth round trip are the auth specification's, and this module's job ends at handing over a
// value with a known shape. `onDeepLink` below is what that specification will subscribe to.

/** The actions a `jaroku://` URL may name. Anything else is refused rather than passed along. */
const ACTIONS = ["auth", "agent", "thread", "test"] as const;

export type DeepLinkAction = (typeof ACTIONS)[number];

export interface DeepLink {
  /** Which of the known actions this is. */
  action: DeepLinkAction;
  /**
   * The rest of the path, split and emptied of blanks — `jaroku://thread/abc/step/4` gives
   * `["abc", "step", "4"]`. Kept as segments rather than as a string so a consumer matches on
   * them rather than re-parsing a path a second time in a second way.
   */
  path: string[];
  /** The query, flattened. A repeated key keeps its FIRST value: a link carrying `?token=a&token=b`
   *  is a link somebody is doing something to, and the last-wins reading is the one an attacker
   *  picks when a parser downstream reads the other. */
  params: Record<string, string>;
  /** The URL exactly as it arrived, for logging. Never re-parsed by anything. */
  raw: string;
}

/**
 * Parse a `jaroku://` URL, or answer `null`.
 *
 * `null` covers every failure with one value on purpose. A caller that has to distinguish "wrong
 * scheme" from "unknown action" from "not a URL" is a caller that will do something different in
 * each case, and there is nothing different worth doing: none of the three is an instruction this
 * application understands, and all three should be logged and dropped.
 */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== "string" || raw === "") return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "jaroku:") return null;

  // `jaroku://auth/callback` puts `auth` in `host` and `/callback` in `pathname`; `jaroku:auth`
  // with no slashes puts the whole thing in `pathname`. Both spellings occur in the wild — the
  // second is what some mail clients produce when they rewrite a link — so the action is taken
  // from whichever of the two has it.
  const segments = [url.host, ...url.pathname.split("/")].map(decodeSafely).filter((s) => s !== "");
  const [head, ...path] = segments;
  if (!head || !isAction(head)) return null;

  // NO SEGMENT MAY BE A TRAVERSAL OR CARRY A SEPARATOR, and this is a refusal rather than a
  // filter: a link with `..` in it was not written by anything this application produces, so the
  // safe reading is that it is not a link this application understands.
  //
  // It is not redundant with `new URL`. That parser resolves `..` for the `jaroku://host/path`
  // form — `jaroku://test/../../etc/passwd` arrives here as `/etc/passwd` — and does NOT for the
  // slashless `jaroku:auth/../x`, whose path is opaque and kept verbatim, nor for `..%2f`, which
  // survives normalisation encoded and becomes a separator inside one segment after the decode
  // above. Both were checked rather than reasoned about. Path segments become ids, slugs and
  // filenames downstream, and `isSafeAgentId` exists because this codebase has been here before.
  if (path.some((segment) => segment === "." || segment === ".." || /[/\\]/.test(segment))) return null;

  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!(key in params)) params[key] = value;
  }

  return { action: head, path, params, raw };
}

function isAction(value: string): value is DeepLinkAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/** A malformed escape sequence is a segment we did not understand, not a crash. `decodeURIComponent`
 *  throws on a lone `%`, which is one character an attacker needs to reach a handler nobody wrote. */
function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// The subscription. This is one of exactly two places in the client that know Tauri exists — the
// other is the session vault — and both of them are structured so that a browser sees nothing.
// ---------------------------------------------------------------------------------------------

/** The event the shell emits. Must match `src-tauri/src/deeplink.rs`'s `EVENT`. */
const EVENT = "jaroku:deep-link";

interface TauriBridge {
  event?: { listen(event: string, handler: (message: { payload: unknown }) => void): Promise<() => void> };
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

/** Reached through the global rather than through `@tauri-apps/api`, so that neither package.json
 *  nor a browser build gains a dependency for a feature only one host has. `withGlobalTauri` in
 *  tauri.conf.json is what puts it there. */
function bridge(): TauriBridge | undefined {
  return (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
}

/**
 * Subscribe to `jaroku://` links. Returns a function that unsubscribes.
 *
 * A NO-OP IN A BROWSER, returning a function that does nothing, so a caller never branches on
 * where it is running. That is the whole contract: the two Tauri-aware modules in this client
 * both behave, absent a host, exactly as if the feature did not exist.
 *
 * The queue is drained BEFORE the listener is attached and the results delivered after — see
 * `deeplink.rs` on why there is a queue at all. Draining first means a link that arrived during
 * startup is not lost in the gap between subscribing and asking; delivering after means the
 * handler is only ever called once it is fully installed.
 */
export function onDeepLink(handler: (link: DeepLink) => void): () => void {
  const tauri = bridge();
  if (!tauri?.event?.listen) return () => {};

  let cancelled = false;
  let unlisten: (() => void) | null = null;

  const deliver = (raw: unknown): void => {
    const link = parseDeepLink(raw);
    if (link) handler(link);
    else console.warn("[jaroku] ignored a link this application does not understand");
  };

  void (async () => {
    const held = (await tauri.core?.invoke("drain_deep_links").catch(() => [])) ?? [];
    const stop = await tauri.event!.listen(EVENT, (message) => deliver(message.payload));
    if (cancelled) stop();
    else unlisten = stop;
    if (Array.isArray(held)) for (const raw of held) deliver(raw);
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

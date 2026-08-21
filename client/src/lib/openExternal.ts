// Opening a web page in the user's own browser, from an application that is not one.
//
// WHY AN ORDINARY `<a href>` IS WRONG HERE, and it is not a preference. The packaged frontend is
// served from `tauri://localhost` (or `https://tauri.localhost` on Windows); a link that navigates
// the webview to `https://jaroku.dev/terms` navigates THE APPLICATION there, and there is no route
// back — the return trip would have to be a web origin loading a `tauri://` one, which no engine
// permits. So an unguarded `<a>` on the sign-in screen is a one-way trip that ends with somebody
// looking at a privacy policy where their app used to be, and a relaunch as the only remedy.
//
// IT IS THE SAME ROUND TRIP `openCheckout` MAKES AND A DIFFERENT ALLOWLIST, deliberately. Both go
// out through `tauri-plugin-opener`, called from Rust, behind a host list the page cannot
// influence — because "this URL came from our own server" is not something the page can prove
// about itself. What differs is which hosts: a payment page is three Stripe hosts and nothing
// else, and that list must not quietly grow to include a documentation site because somebody
// needed one link. Two lists, two commands, two reasons.
//
// AND THIS LIVES IN `deepLink.ts`'s FILE ON THE RUST SIDE AND ITS OWN ON THIS ONE. The invariant
// docs/tauri.md states — three modules in this client know Tauri exists — was already four when
// `hostBackend.ts` landed, and it is five now. The number was never the point; the property was:
// each of them is a NO-OP in a browser, so no caller anywhere branches on where it is running.
// This one keeps that exactly. In a browser it falls back to `window.open`, which is the correct
// behaviour there and has always been.

/** Where a person is sent for the things these screens link to. Spelled once. */
export const HELP_URLS = {
  terms: "https://jaroku.dev/terms",
  privacy: "https://jaroku.dev/privacy",
  /** §2.3's "Get help" — the documented troubleshooting page for a failed first run. */
  firstRunHelp: "https://jaroku.dev/help/first-run",
  /** §5.1 step 3's "Where do I find this?", per provider. */
  anthropicKeys: "https://console.anthropic.com/settings/keys",
  openaiKeys: "https://platform.openai.com/api-keys",
  googleKeys: "https://aistudio.google.com/app/apikey",
} as const;

interface TauriBridge {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

function bridge(): TauriBridge | undefined {
  return (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
}

/**
 * Open a page in the user's own browser, and say whether that worked.
 *
 * `false` means nothing happened and the caller should say so — which for every caller here means
 * showing the URL as text somebody can copy. That is a real fallback rather than a shrug: the
 * refusal cases are a host that is not on the list (a bug worth seeing) and a machine with no
 * browser configured (rare, real, and not the user's fault), and in both of them a URL on screen
 * is strictly better than a button that does nothing.
 */
export async function openExternal(url: string): Promise<boolean> {
  const tauri = bridge();
  if (!tauri?.core?.invoke) {
    // A browser. `window.open` is exactly right here and always was — the page is already in a
    // browser, so there is nothing to hop out to and a new tab is what a link means.
    try {
      // `noopener` because the opened page gets a handle on `window.opener` without it, which is
      // a page we do not control holding a reference to this one.
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    } catch {
      return false;
    }
  }
  try {
    await tauri.core.invoke("open_external", { url });
    return true;
  } catch (err) {
    // The shell refused it or could not launch anything. Logged rather than thrown: the caller's
    // fallback is to show the link, which is a better outcome than an error boundary.
    console.warn(`[jaroku] could not open ${url}: ${String(err)}`);
    return false;
  }
}

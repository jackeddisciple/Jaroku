// §9.2 — which workspace this window is showing, on the window itself.
//
// WHY IT IS WORTH A MODULE. §9's argument is the one sentence the whole section turns on:
// "deploying to the wrong workspace is the team-scale equivalent of rm -rf /". The switcher at the
// top of the sidebar answers that for somebody looking at the app. The title answers it for
// somebody who is NOT — alt-tabbing between two windows, reading a taskbar, picking a window out
// of a list after lunch — which is precisely when the mistake gets made.
//
// TWO SURFACES, ONE FACT. `document.title` is what a browser tab shows and is all there is on the
// web. Under a desktop shell the native window has a title of its own, set when the window was
// created, and nothing the page writes to `document.title` reaches it — so the shell is asked as
// well. Both are set from the same call, so they cannot disagree.
//
// THROUGH `__TAURI__.core.invoke` AND NOT `@tauri-apps/api`, which makes this the fourth module in
// this client that knows it might be inside Tauri — `docs/tauri.md` names the other three. It is
// deliberately the same shape as `sessionVault.ts` and `deepLink.ts`: read the global, do nothing
// if it is absent, and never import the package, so `package.json` gains no dependency and a
// browser build carries no dead code.

/** The shape this module needs of the host bridge. See `sessionVault.ts` for the same shim. */
interface TauriBridge {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
}

function bridge(): TauriBridge | undefined {
  // `globalThis` rather than `window`, because every suite in this repository runs under tsx where
  // `window` is not defined and reading it throws at module load.
  const value = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * The string both surfaces show. Exported because it is the part worth asserting.
 *
 * THE PRODUCT NAME COMES FIRST, which is the opposite of what a browser tab usually does and is
 * right here: a taskbar truncates from the RIGHT, and a window list showing "Acme Corp — Ja…"
 * beside "Personal — Ja…" has told somebody which workspace each window is and lost which
 * application they belong to — while "Jaroku — Acme…" and "Jaroku — Person…" keep both halves
 * legible at every width a taskbar button actually gets.
 *
 * An absent name yields the product's own name alone, never "Jaroku — " with nothing after it.
 * That is the state before a session lands, and it is on screen for a frame on every launch.
 */
export function titleFor(workspaceName: string | null | undefined): string {
  const name = (workspaceName ?? "").trim();
  return name ? `Jaroku — ${name}` : "Jaroku";
}

/**
 * Put the workspace's name on this window.
 *
 * IDEMPOTENT AND CHEAP, because the caller is a React effect on a value that changes for reasons
 * other than a switch — a rename, a session refresh, a re-render. The last title is remembered so
 * an unchanged one costs nothing rather than crossing the IPC boundary on every hydration.
 *
 * FAILURES ARE SWALLOWED. The worst case is a window whose title is one workspace behind, which is
 * a cosmetic loss; raising over it would put an error dialog in front of somebody for the sake of
 * a caption, and the shell refusing this command is not something a person can act on.
 */
let last: string | null = null;

export function setWindowTitle(workspaceName: string | null | undefined): void {
  const title = titleFor(workspaceName);
  if (title === last) return;
  last = title;
  try {
    if (typeof document !== "undefined") document.title = title;
  } catch {
    /* no document — a suite, or a worker */
  }
  const invoke = bridge()?.core?.invoke;
  if (!invoke) return;
  // The name rather than the assembled title: the shell composes it, so the em dash and the
  // product's own name are spelled in one place. See `window.rs`.
  void invoke("set_window_title", { name: (workspaceName ?? "").trim() }).catch(() => {});
}

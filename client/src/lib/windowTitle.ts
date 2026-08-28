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
export function titleFor(workspaceName: string | null | undefined, waiting = 0): string {
  const name = (workspaceName ?? "").trim();
  const base = name ? `Jaroku — ${name}` : "Jaroku";
  // THE COUNT GOES IN FRONT, which is where a taskbar and a tab strip both truncate LAST. The
  // product name leads for the reason above — a window list truncates from the right — and a count
  // that led would push it out; a count that trailed would be the first thing cut. `(2)` before the
  // name is the one position that survives both.
  return waiting > 0 ? `(${waiting}) ${base}` : base;
}

/**
 * §20's rule for what may reach the window: `waiting`, and nothing else.
 *
 * "`windowTitle.ts` exists because, in its own words, the mistake gets made by somebody who is NOT
 * LOOKING AT THE APP — alt-tabbing, reading a taskbar, picking a window out of a list after lunch.
 * A JOB WAITING ON A PERSON IS EXACTLY THAT SITUATION. When the tab is backgrounded and something
 * is `waiting`, the count reaches the title, through that module, alongside the workspace it
 * already carries. NOTHING ELSE REACHES IT: not running, not failed. The same scarcity rule as the
 * badge."
 *
 * SO THIS IS A THIRD SURFACE UNDER ONE RULE, and it is worth naming all three together: the sidebar
 * badge counts `waiting` and nothing else, the Cockpit's live region announces `waiting` and
 * nothing else, and the window title carries `waiting` and nothing else. One question — is a person
 * the blocker — and the moment a fourth thing reaches any of them, all three become ignorable.
 *
 * ONLY WHEN THE TAB IS BACKGROUNDED, which is the clause that keeps it from being noise. Somebody
 * looking at the app can see the badge; the title is for somebody who cannot, and a count that
 * appeared in the title of the window they are already reading would be the same fact twice.
 *
 * `document.visibilityState` RATHER THAN `hasFocus`, because they answer different questions. A
 * window can be unfocused and fully visible on a second monitor — which is precisely the reader
 * this feature is for — and `hasFocus` would put the count in a title they are looking straight at.
 * Visibility means the tab is genuinely not on screen.
 */
export function backgrounded(): boolean {
  try {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  } catch {
    // No document — a suite, or a worker. Not backgrounded, because there is no foreground either.
    return false;
  }
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

export function setWindowTitle(workspaceName: string | null | undefined, waiting = 0): void {
  const title = titleFor(workspaceName, waiting);
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

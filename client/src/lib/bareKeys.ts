// WHO OWNS A BARE LETTER, which is a rule this client already had and kept in five copies.
//
// `CommandPalette` states it, in the comment above the `j`/`k` handler: "AND NEVER WHILE A
// FULL-SCREEN VIEW IS UP. J/K move a thread row there exactly as they move a trace step here … The
// view that owns the screen owns the bare keys." That is right, and it was applied to `j`, to `k`
// and to `Enter`.
//
// IT WAS NOT APPLIED TO `R`. That listener is registered on `window` from `BuildPane`, which stays
// mounted behind a full-screen destination on purpose — App.tsx keeps the three panes alive so a
// half-typed message survives a trip to the Inbox. So pressing `r` on the Threads board, with the
// composer, the run button and the trace panel all behind a full-screen view, dispatched a real run
// of whichever agent was selected in the sidebar. Nothing on screen changed to say so. On a
// workspace with a provider key that spends money, with no confirmation and no visible result — and
// `r` is a plausible keystroke on a board where somebody expects typing to reach a filter field.
//
// SO THE RULE IS A MODULE NOW RATHER THAN A CONDITION WRITTEN AT EACH LISTENER. A rule copied at
// five call sites is a rule the sixth listener is written without, which is exactly how this
// happened: `R` guards the modifiers and the typing targets — the two halves that are obvious while
// you are writing a key handler — and misses the one that is about the rest of the application.
//
// TWO PREDICATES, BECAUSE THERE ARE TWO KINDS OF OWNER. A handler belonging to the three-pane view
// must stand down while a destination owns the screen; a handler belonging to a destination must
// not, because it is the one that owns it. Naming both here is what makes the distinction a
// decision somebody makes rather than a check somebody forgets.
//
//   npm run test:bare-keys

/** Anything that swallows a bare letter: a filter field, a rename in progress, the composer. */
export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** The parts of an event a bare-key guard reads. A real `KeyboardEvent` satisfies it. */
export interface BareKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** What the guard needs to know about the rest of the application. */
export interface BareKeyScreen {
  /** The full-screen destination that owns the screen, or null for the ordinary three-pane view. */
  navView: string | null;
  paletteOpen: boolean;
}

/**
 * May a bare-key handler belonging to the THREE-PANE VIEW act on this event?
 *
 * `BuildPane`'s `R` and `CommandPalette`'s `j`/`k`/`Enter`. It stands down whenever a full-screen
 * destination is up, because that view owns the screen and therefore owns the letter.
 */
export function paneOwnsBareKey(e: BareKeyEvent, screen: BareKeyScreen): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (screen.navView !== null) return false;
  if (screen.paletteOpen) return false;
  return !isTypingTarget(e.target);
}

/**
 * May a bare-key handler belonging to a FULL-SCREEN DESTINATION act on this event?
 *
 * The mirror of the above, and deliberately without a `navView` clause: these listeners are mounted
 * by the view that is up, so a `navView` check there would disable the keys on the only screen they
 * belong to. The palette still wins, because it is an overlay over whatever is beneath it.
 */
export function viewOwnsBareKey(e: BareKeyEvent, screen: Pick<BareKeyScreen, "paletteOpen">): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (screen.paletteOpen) return false;
  return !isTypingTarget(e.target);
}

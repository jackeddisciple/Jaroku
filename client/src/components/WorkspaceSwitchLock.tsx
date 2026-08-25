// §5.1 step 1 and step 7 — the lock over the app while a workspace switch is in flight.
//
// WHAT IT IS FOR, WHICH IS NOT "SHOWING PROGRESS". By the time this renders, every store has been
// emptied and the socket is closed: there is no stale data left to protect anybody from, and no
// command could reach the old workspace even if one were sent, because `send` has no socket. What
// remains is the half a second in which the application is a working set of controls over nothing
// — an empty agent list with a `+` on it, a composer that would swallow a message, a Deploy button
// on a card that is not there. Clicking any of it does nothing and looks like the app has broken.
// The scrim makes that half-second read as a transition rather than as a fault.
//
// NOT A FULL-SCREEN LOADER, which §5.1 asks for by name. It is translucent, the shell stays
// visible through it, and it says which workspace it is waiting for — the point is that somebody
// can see where they are going, not that the application has been replaced by a spinner.
//
// AND IT IS THE SAME COMPONENT THAT REPORTS THE FAILURE, because the two states are one story: a
// switch that does not arrive reverts, and the sentence explaining that has to appear in the place
// the lock was. §5.2 puts it "inline in the switcher"; the switcher is a row at the top of the
// sidebar, so the strip renders directly beneath it — see WorkspaceSwitcher, which draws it.

import { useSessionStore } from "../store/sessionStore.ts";
import { LoaderIcon } from "./panelIcons.tsx";
import { ICON } from "../lib/tokens.ts";

export function WorkspaceSwitchLock() {
  const switching = useSessionStore((s) => s.switching);
  if (!switching) return null;

  return (
    <div
      // `pointer-events-auto` IS THE WHOLE MECHANISM. Everything else here is presentation; this
      // one property is what §5.1's "the user must not be able to interact with stale data" comes
      // down to in a browser. A scrim that let clicks through would be decoration.
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-void/55 backdrop-blur-[1px]"
      // `status` rather than `alert`: this is a state somebody is waiting on, not an interruption,
      // and `alert` would make a screen reader cut off whatever it was reading.
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 rounded-card border border-edge bg-panel px-3 py-2 shadow-floating">
        <span className="animate-spin text-muted motion-reduce:animate-none" aria-hidden>
          <LoaderIcon size={ICON.sm} />
        </span>
        {/* THE NAME, NOT "LOADING". A switch is the one transition in this product where what
            matters is WHICH thing is arriving — §9's whole argument is that knowing which
            workspace you are in prevents the mistake. */}
        <span className="text-caption text-ink">Switching to {switching.name}…</span>
      </div>
    </div>
  );
}

// The full-screen region a sidebar nav button opens (§2).
//
// ONE SWITCH, FOUR DESTINATIONS, AND ALL FOUR ARE BUILT. Threads came first, Agents second, the
// Inbox third and Activity last; the mechanism this shell was built for is what made plugging each
// one in a case in this switch and nothing else, exactly as its own comment promised. The
// placeholder machinery below it is gone with the last placeholder, which is the honest end state:
// a `NOT_HERE` table with no entries would be a shape kept warm for nothing.
//
// THE FOURTH TAB IS THE INBOX AND NOT MEMORY, which is a change of what the destination IS. v0.3.0
// recorded Memory as a shell and nothing was ever built behind it; what ships instead is the surface
// the idea was for — a memory Jaroku proposes from a failure → fix → pass triple is an ITEM on this
// board, answered where it is raised, rather than a tab somebody has to go and read.
//
// THE PLACEHOLDERS ARE NOT DECORATION. This product's disabled-state discipline is to state what is
// true rather than to hide the control: the nav buttons exist because §2 says the sidebar has four,
// and a button that silently did nothing would be the one thing worse than one that explains itself.
// They are deliberately plain — no illustration, no "coming soon" with a mailing list.
//
// WHY THE SIDEBAR IS NOT IN HERE. It is outside this component and outside the panel this renders
// into, because §2's contract is that the sidebar is untouched: it does not move, it does not
// collapse, and it keeps its selection. A full-screen view that owned the whole window would have to
// re-render the sidebar to satisfy that, and would then be able to get it wrong.

import type { NavDestination } from "../store/uiStore.ts";
import { ThreadsView } from "./ThreadsView.tsx";
import { AgentsView } from "./AgentsView.tsx";
import { InboxView } from "./InboxView.tsx";
import { ActivityDashboard } from "./ActivityDashboard.tsx";

export function FullScreenView({ destination }: { destination: NavDestination }) {
  if (destination === "threads") return <ThreadsView />;
  if (destination === "agents") return <AgentsView />;
  if (destination === "inbox") return <InboxView />;
  return <ActivityDashboard />;
}

// The full-screen region a sidebar nav button opens (§2).
//
// ONE SWITCH, FOUR DESTINATIONS, THREE OF THEM BUILT. Threads came first, Agents second and the Inbox
// third; the mechanism that shell was built for is what made plugging each one in a case in this
// switch and nothing else, exactly as its own comment promised. Activity is specified separately and
// must not be built here.
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
import { EmptyState } from "./EmptyState.tsx";
import { ThreadsView } from "./ThreadsView.tsx";
import { AgentsView } from "./AgentsView.tsx";
import { InboxView } from "./InboxView.tsx";
import { ActivityIcon } from "./panelIcons.tsx";

/** What each unbuilt destination says for itself. Short, factual, present tense (§9). */
const NOT_HERE: Record<Exclude<NavDestination, "threads" | "agents" | "inbox">, { title: string; hint: string }> = {
  activity: {
    title: "Activity is a separate surface",
    hint: "Specified apart from Threads. Per-thread cost is on the rows in Threads; the workspace roll-up belongs here.",
  },
};

const ICON: Record<Exclude<NavDestination, "threads" | "agents" | "inbox">, typeof ActivityIcon> = {
  activity: ActivityIcon,
};

export function FullScreenView({ destination }: { destination: NavDestination }) {
  if (destination === "threads") return <ThreadsView />;
  if (destination === "agents") return <AgentsView />;
  if (destination === "inbox") return <InboxView />;
  const { title, hint } = NOT_HERE[destination];
  return (
    <div className="flex h-full flex-col bg-bg">
      <EmptyState icon={ICON[destination]} title={title} hint={hint} />
    </div>
  );
}

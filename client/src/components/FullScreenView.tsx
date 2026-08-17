// The full-screen region a sidebar nav button opens (§2).
//
// ONE SWITCH, FOUR DESTINATIONS, AND ONLY ONE OF THEM BUILT HERE. This document covers Threads; the
// other three are specified separately and must not be built here. What this commit owes them is the
// mechanism — the shell is generic, so plugging Agents in later is a case in this switch and nothing
// else — and what it owes a person who clicks Agents today is a screen that says so rather than a
// blank region.
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
import { ActivityIcon, DatabaseIcon, SparklesIcon } from "./panelIcons.tsx";

/** What each unbuilt destination says for itself. Short, factual, present tense (§9). */
const NOT_HERE: Record<Exclude<NavDestination, "threads">, { title: string; hint: string }> = {
  agents: {
    title: "Agents is a separate surface",
    hint: "Its own specification covers it. The agent list in the sidebar is still how you pick one.",
  },
  memory: {
    title: "Memory is a separate surface",
    hint: "Specified apart from Threads, and not built in this pass.",
  },
  activity: {
    title: "Activity is a separate surface",
    hint: "Specified apart from Threads. Per-thread cost is on the rows in Threads; the workspace roll-up belongs here.",
  },
};

const ICON: Record<Exclude<NavDestination, "threads">, typeof SparklesIcon> = {
  agents: SparklesIcon,
  memory: DatabaseIcon,
  activity: ActivityIcon,
};

export function FullScreenView({ destination }: { destination: NavDestination }) {
  if (destination === "threads") return <ThreadsView />;
  const { title, hint } = NOT_HERE[destination];
  return (
    <div className="flex h-full flex-col bg-bg">
      <EmptyState icon={ICON[destination]} title={title} hint={hint} />
    </div>
  );
}

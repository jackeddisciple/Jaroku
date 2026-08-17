// The full-screen Threads list (§4).
//
// A PLACEHOLDER IN THIS COMMIT, ON PURPOSE. What ships here is the shell of §2 — a nav button
// replacing both right-hand panes with one full-width region while the sidebar stays exactly where
// it is — and the row, the grouping, the filter bar and the keyboard are the commits that follow. The
// header and the count below are real, because they come from the snapshot the store already holds,
// and shipping a screen that renders nothing at all would make the shell untestable by hand.

import { useThreadStore } from "../store/threadStore.ts";
import { TYPE } from "../lib/tokens.ts";
import { EmptyState } from "./EmptyState.tsx";
import { PlusIcon } from "./panelIcons.tsx";

export function ThreadsView() {
  const threads = useThreadStore((s) => s.threads);
  const counts = useThreadStore((s) => s.counts);
  const loaded = useThreadStore((s) => s.loaded);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* §4.1: the title, and the one action this surface owns. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3">
        <span className={TYPE.panelLabel}>Threads</span>
        <span className="text-faint text-[11px] tabular-nums">{counts.all}</span>
        <button
          className="ml-auto flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
          title="New thread"
        >
          <PlusIcon size={12} /> New thread
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* NOT A SPINNER (§9). "We have not been told yet" is a real state and shows what is
            happening; a static spinner would say only that something is. The rows themselves land in
            the commits below, so until then this is the count the snapshot carries. */}
        {!loaded ? (
          <div className="px-5 py-4 text-[12px] text-muted">Reading this workspace's threads…</div>
        ) : threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            hint="Describe an agent in the composer and the first one opens itself."
          />
        ) : (
          <ul className="py-1">
            {threads.map((t) => (
              <li key={t.id} className="px-5 py-2 text-[13px] text-ink">
                {t.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

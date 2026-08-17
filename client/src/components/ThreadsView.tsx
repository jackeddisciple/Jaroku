// The full-screen Threads list (§4).
//
// WHAT IS HERE NOW: the header, the three sections of §4.2, the rows, and the transition out. The
// filter bar of §4.4 and the keyboard of §4.7 are the commits that follow.
//
// THE SECTIONS COME FROM `lib/threadGroups.ts` RATHER THAN FROM THIS FILE, because the interesting
// half is an ordering — Needs You oldest-first, everything else newest-first — and an ordering is
// exactly what looks right in a screenshot and is wrong in the case nobody had that day. It is a pure
// function with a suite; this renders what it returns.

import { useThreadStore } from "../store/threadStore.ts";
import { groupThreads } from "../lib/threadGroups.ts";
import { openThread, openThreadAgent } from "../lib/threadNav.ts";
import { sendCreateThread, sendRenameThread } from "../lib/socket.ts";
import { TYPE } from "../lib/tokens.ts";
import { EmptyState } from "./EmptyState.tsx";
import { ThreadRow } from "./ThreadRow.tsx";
import { PlusIcon } from "./panelIcons.tsx";

export function ThreadsView() {
  const threads = useThreadStore((s) => s.threads);
  const counts = useThreadStore((s) => s.counts);
  const loaded = useThreadStore((s) => s.loaded);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const error = useThreadStore((s) => s.error);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* §4.1: the title, the count, and the one action this surface owns. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3">
        <span className={TYPE.panelLabel}>Threads</span>
        <span className="text-faint text-[11px] tabular-nums">{counts.all}</span>
        <button
          onClick={() => sendCreateThread()}
          className="ml-auto flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-active hover:text-ink"
          title="New thread"
        >
          <PlusIcon size={12} /> New thread
        </button>
      </div>

      {/* A refusal is shown rather than swallowed, and it is dismissed by the next snapshot rather
          than by a close button — the list being right again is what makes it stale. */}
      {error && (
        <div className="shrink-0 border-b border-hair px-5 py-2 text-[11px] text-err">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded ? (
          // NOT A SPINNER (§9). Three skeleton rows at the row's own geometry, so the list does not
          // jump when the real ones land — and so the wait says what is coming rather than only that
          // something is.
          <div className="py-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="px-5 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full bg-active" />
                  <span className="h-3 flex-1 rounded bg-active" style={{ maxWidth: `${52 - i * 8}%` }} />
                </div>
                <div className="mt-1.5 ml-5 h-2.5 w-1/3 rounded bg-active/70" />
              </div>
            ))}
          </div>
        ) : threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            hint="Describe an agent in the composer and the first one opens itself."
          />
        ) : (
          <div className="py-1">
            {groupThreads(threads).map((section) => (
              <section key={section.id}>
                {/* The header carries the count and a rule out to the right edge, as §4.1's wireframe
                    draws it. An empty section is not here at all — `groupThreads` does not return one
                    — so there is no "0 items" to render and no placeholder to decide the shape of. */}
                <div className="flex items-center gap-3 px-5 pt-3 pb-1">
                  <span className="text-[10px] font-medium tracking-wider text-faint">{section.label}</span>
                  <span className="h-px flex-1 bg-hair" />
                  <span className="text-[10px] text-faint tabular-nums">{section.threads.length}</span>
                </div>
                {section.threads.map((t) => (
                  <ThreadRow
                    key={t.id}
                    thread={t}
                    // The row the CENTRE PANE is holding, until §4.7's J/K cursor arrives and takes
                    // this over. Two different ideas of "selected" that happen to coincide today.
                    selected={t.id === activeThreadId}
                    onOpen={() => openThread(t)}
                    onOpenAgent={openThreadAgent}
                    onRename={(title) => sendRenameThread(t.id, title)}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

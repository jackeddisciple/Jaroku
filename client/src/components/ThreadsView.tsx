// The full-screen Threads list (§4).
//
// WHAT IS HERE NOW: the header, the filter bar of §4.4, the three sections of §4.2, and the transition
// out. The keyboard of §4.7 is the commit that follows.
//
// THE SECTIONS AND THE FILTER ARE PURE FUNCTIONS IN THEIR OWN MODULES, not code in this file, because
// the interesting halves are an ordering and a match rule — and both are exactly what looks right in a
// screenshot and is wrong in the case nobody had that day. This file renders what they return.
//
// FILTER STATE IS LOCAL, WHICH IS THE REQUIREMENT RATHER THAN A SHORTCUT. §4.4: filter state is per
// session and reopening Threads starts at All. Local state does that by construction — the view
// unmounts when you leave it — where a store would have to be remembered to be cleared.

import { useEffect, useRef, useState } from "react";
import { useThreadStore } from "../store/threadStore.ts";
import { groupThreads } from "../lib/threadGroups.ts";
import { filterThreads, FILTER_LABEL, type ThreadFilter } from "../lib/threadFilter.ts";
import { openThread, openThreadAgent } from "../lib/threadNav.ts";
import { sendCreateThread, sendRenameThread } from "../lib/socket.ts";
import { TYPE } from "../lib/tokens.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { EmptyState } from "./EmptyState.tsx";
import { ThreadFilterBar } from "./ThreadFilterBar.tsx";
import { ThreadRow } from "./ThreadRow.tsx";
import { useThreadKeys } from "./useThreadKeys.ts";
import { PlusIcon, SearchIcon } from "./panelIcons.tsx";

/**
 * §4.6's first empty state, which is an ENTRY POINT rather than a notice.
 *
 * "The empty state is the entry point — no illustration, no marketing copy." So this is a composer
 * input: type a description, press Enter, and the three-pane view opens with what was typed already in
 * the real composer. It does not send anything itself — there is one composer in this product and one
 * place a brief is submitted from, and a second sender here would be a second set of promises about
 * what happens next (the plan gate, the connector selection, the provider).
 *
 * THE WORKSPACE IS NAMED when it can be, which is the third empty state folded into the first: after a
 * switch, "No threads in Acme Corp yet" reads as an empty scope, where a bare "No threads yet" reads
 * as data that has gone missing.
 */
function FirstThreadStart({ workspaceName }: { workspaceName: string | null }) {
  const [draft, setDraft] = useState("");
  const start = (): void => {
    const text = draft.trim();
    if (!text) return;
    // Hand it to the composer and go there. `prefillChat` is the same one-shot intent the GitHub
    // panel's Fix in Jaroku uses, and `closeNav` is §2's ordinary way back to the three panes.
    useUiStore.getState().prefillChat(text);
    useUiStore.getState().closeNav();
    useUiStore.getState().focusChat();
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-[min(560px,90%)]">
        <div className="text-center text-[13px] text-ink">
          {workspaceName ? `No threads in ${workspaceName} yet` : "No threads yet"}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-control border border-edge bg-panel px-3 py-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter starts it; nothing else here is a shortcut, and the view's own J/K must not fire
              // from inside a field somebody is typing a sentence into.
              e.stopPropagation();
              if (e.key === "Enter") start();
            }}
            placeholder="Describe an agent to start your first thread."
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint outline-none"
          />
          <span className="shrink-0 text-[10px] text-faint">↵</span>
        </div>
      </div>
    </div>
  );
}

export function ThreadsView() {
  const threads = useThreadStore((s) => s.threads);
  const counts = useThreadStore((s) => s.counts);
  const loaded = useThreadStore((s) => s.loaded);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const error = useThreadStore((s) => s.error);
  const workspaceName = useSessionStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name ?? null);

  const [filter, setFilter] = useState<ThreadFilter>("all");
  const [query, setQuery] = useState("");
  const filterInput = useRef<HTMLInputElement | null>(null);
  /**
   * §4.7's cursor: where J/K is, which is NOT the same as which thread the centre pane holds.
   *
   * It starts on the open thread when there is one, because somebody who came back to this list is
   * most likely looking for where they were — but it moves independently from then on, and pressing
   * Enter is what makes the two the same again.
   */
  const [cursor, setCursor] = useState<string | null>(activeThreadId);

  const visible = filterThreads(threads, filter, query);
  // The Archived chip renders a FLAT list, not sections. §4.2's three sections are about what is
  // outstanding, and nothing in an archived thread is outstanding — grouping them under NEEDS YOU
  // would be asking for attention the archive was meant to stop asking for.
  const sections = filter === "archived"
    ? [{ id: "archived" as const, label: "ARCHIVED", threads: visible }]
    : groupThreads(visible);
  // The rows in the order they RENDER, which is what J/K has to walk — the sections reorder them, so a
  // cursor moving through the store's array would jump around the screen.
  const ordered = sections.flatMap((s) => s.threads);

  useThreadKeys({
    rows: ordered,
    cursor,
    setCursor,
    setFilter,
    focusFilter: () => filterInput.current?.focus(),
  });

  // A cursor on a row that is no longer rendered — filtered out, archived, or removed by somebody
  // else's snapshot — is a cursor nobody can see moving. It falls back to the first row rather than to
  // nothing, so the next keystroke does something.
  useEffect(() => {
    if (cursor && !ordered.some((t) => t.id === cursor)) setCursor(ordered[0]?.id ?? null);
  }, [cursor, ordered]);

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

      <ThreadFilterBar
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        counts={counts}
        inputRef={filterInput}
      />

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
          <FirstThreadStart workspaceName={workspaceName} />
        ) : visible.length === 0 ? (
          // §4.6's second: never a blank region. It names what was typed, or which chip is empty when
          // nothing was — "no archived threads" is a different sentence from "nothing matches".
          <EmptyState
            icon={SearchIcon}
            title={query.trim() ? `No threads match ${query.trim()}` : `Nothing under ${FILTER_LABEL[filter]}`}
            hint={
              query.trim() ? (
                <button onClick={() => setQuery("")} className="text-muted underline decoration-dotted hover:text-ink">
                  Clear the filter
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="py-1">
            {sections.map((section) => (
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
                    // §4.7's cursor, which is where the keyboard is. The thread the centre pane holds
                    // is a different fact and is not marked here: this list's job is to be navigated,
                    // and two highlights in one column would compete for the same meaning.
                    selected={t.id === (cursor ?? activeThreadId)}
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

// The row over the conversation: the computer it runs on and whether it is connected, then the
// conversation's own name and what can be done to it.
//
// A BROWSER GETS NO COMPUTER. There is no machine to name there — `readMachineName` resolves to null —
// and "Connected" under an empty name would be a status about nothing. The title and its menu still show.

import { useEffect, useRef, useState } from "react";

import { chatMarkdown } from "../lib/chatMarkdown.ts";
import { readMachineName } from "../lib/hostMachine.ts";
import { Icon } from "../lib/icons/registry.ts";
import { useMenuFocus } from "../lib/menuFocus.ts";
import { sendArchiveThread, sendCreateThread, sendRenameThread, sendRestoreThread } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { threadFor, useChatStore } from "../store/chatStore.ts";
import { threadById, useThreadStore } from "../store/threadStore.ts";
import { useTraceStore, type ConnectionState } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { ThreadView } from "../types.ts";
import { Truncate } from "./Truncate.tsx";

/** This computer's name, once the shell has said it. Null in a browser and until then. */
function useMachineName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readMachineName().then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  }, []);
  return name;
}

const CONNECTION_WORD: Record<ConnectionState, string> = {
  open: "Connected",
  connecting: "Connecting…",
  closed: "Disconnected",
};

const CONNECTION_TONE: Record<ConnectionState, string> = {
  open: "text-muted",
  connecting: "text-faint",
  closed: "text-err",
};

/** The computer, by the name its owner gave it, over whether Jaroku can reach it right now. */
export function MachineChip({ name, connection }: { name: string; connection: ConnectionState }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2" title={`Jaroku on ${name}`}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-chrome text-ink" aria-hidden>
        <Icon.chatHeader.machine size={ICON.sm} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-[220px] truncate text-label text-ink">{name}</span>
        <span className={`text-tiny ${CONNECTION_TONE[connection]}`} aria-live="polite">
          {CONNECTION_WORD[connection]}
        </span>
      </span>
    </div>
  );
}

/**
 * The conversation's name, renamed where it stands.
 *
 * A CLICK OPENS THE FIELD IN PLACE, and so does Rename in the menu beside it. Enter saves, Escape puts
 * the old name back. Leaving the field saves only a CHANGED name: saving marks the title as chosen,
 * which stops it being titled automatically, and a click in and out again is not a choice. Enter on
 * an unchanged name is one — the thread list's rename works the same way.
 *
 * ONLY FOR SOMEBODY WHO MAY RENAME, AND ONLY WHILE CONNECTED. Otherwise the name is plain text: a
 * field that took a new name over a dead socket would drop it without a word.
 */
export function ThreadTitle({
  thread,
  connected,
  editing,
  onEditingChange,
}: {
  thread: ThreadView;
  connected: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const canRename = useCanRun("renameThread");
  const [draft, setDraft] = useState(thread.title);
  const input = useRef<HTMLInputElement>(null);
  /** Escape ended this edit, so the blur that follows must not save it. */
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    cancelled.current = false;
    setDraft(thread.title);
    input.current?.focus();
    input.current?.select();
    // `thread.title` left out on purpose: a list update arriving mid-edit must not replace what is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const finish = (save: "always" | "if-changed"): void => {
    onEditingChange(false);
    if (cancelled.current) return;
    const next = draft.trim();
    if (!next) return;
    if (save === "if-changed" && next === thread.title) return;
    sendRenameThread(thread.id, next);
  };

  if (editing && canRename && connected) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish("if-changed")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish("always");
          else if (e.key === "Escape") { cancelled.current = true; onEditingChange(false); }
        }}
        aria-label="Chat name"
        maxLength={240}
        className="h-7 min-w-0 max-w-[360px] flex-1 rounded-input border border-edge bg-elevated px-2 text-label text-ink outline-none focus-visible:shadow-focusring"
      />
    );
  }

  if (!canRename || !connected) {
    return (
      <span className="min-w-0 max-w-[360px] px-2">
        <Truncate className="text-label text-ink" title={thread.title}>{thread.title}</Truncate>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      title="Rename this chat"
      className="flex h-7 min-w-0 max-w-[360px] items-center rounded-control px-2 text-left transition-colors duration-fast hover:bg-active/40 focus-visible:outline-none focus-visible:shadow-focusring"
    >
      <Truncate className="text-label text-ink" title={thread.title}>{thread.title}</Truncate>
    </button>
  );
}

const MENU_ROW =
  "flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-caption text-muted transition-colors hover:bg-active/40 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-default disabled:text-disabled disabled:hover:bg-transparent";

/** How long "Copied" stays beside the menu after Share Chat. */
const NOTE_MS = 1200;

/**
 * What can be done to the open conversation.
 *
 * AN ITEM THIS ACCOUNT CANNOT USE IS ABSENT, not greyed — the rule `Capable` states. One it can use
 * but that needs the socket is disabled while reconnecting, with the reason as its title, because a
 * press that left the tab with nothing would be a control that did nothing.
 *
 * SHARE CHAT COPIES THE CONVERSATION AS MARKDOWN, and says so beside the menu once the clipboard has
 * taken it — or says that it did not.
 */
function ThreadMenu({ thread, connected, onRename }: { thread: ThreadView; connected: boolean; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useUiStore((s) => s.pinnedThreads.includes(thread.id));
  const archived = thread.archived_at !== null;
  const canRename = useCanRun("renameThread");
  const canArchive = useCanRun(archived ? "restoreThread" : "archiveThread");
  // Agent-scoped: whether this person may start a chat about THIS chat's agent, or a plain one.
  const canCreate = useCanRun("createThread", thread.agent_id);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useMenuFocus(open, ref);

  const say = (text: string): void => {
    setNote(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const share = async (): Promise<void> => {
    const chat = useChatStore.getState();
    const turns = threadFor({ threads: chat.threads, pending: chat.pending }, thread.id);
    try {
      await navigator.clipboard.writeText(chatMarkdown(thread.title, turns));
      say("Copied");
    } catch {
      say("Couldn't reach the clipboard");
    }
  };

  const choose = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const offline = connected ? undefined : "Reconnecting — this needs a connection";

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chat actions"
        title="Chat actions"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-active/40 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Icon.chatHeader.menu size={ICON.sm} />
      </button>
      <span aria-live="polite" className="text-tiny text-muted">{note ?? ""}</span>

      {open && (
        <div
          role="menu"
          aria-label="Chat actions"
          className="absolute left-0 top-full z-50 mt-1 min-w-[200px] origin-top animate-menu-in overflow-hidden rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none"
        >
          <button
            type="button"
            role="menuitem"
            onClick={choose(() => useUiStore.getState().togglePinnedThread(thread.id))}
            className={MENU_ROW}
          >
            <Icon.chatHeader.pin size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">{pinned ? "Unpin" : "Pin"}</span>
          </button>
          {canRename && (
            <button type="button" role="menuitem" disabled={!connected} title={offline} onClick={choose(onRename)} className={MENU_ROW}>
              <Icon.chatHeader.rename size={ICON.sm} />
              <span className="min-w-0 flex-1 truncate">Rename</span>
            </button>
          )}
          {canArchive && (
            <button
              type="button"
              role="menuitem"
              disabled={!connected}
              title={offline}
              onClick={choose(() => {
                if (archived) sendRestoreThread(thread.id);
                else if (sendArchiveThread(thread.id)) useThreadStore.getState().noteArchived(thread);
              })}
              className={MENU_ROW}
            >
              <Icon.chatHeader.archive size={ICON.sm} />
              <span className="min-w-0 flex-1 truncate">{archived ? "Restore" : "Archive"}</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={choose(() => void share())} className={MENU_ROW}>
            <Icon.chatHeader.share size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">Share Chat</span>
          </button>
          {canCreate && (
            <button
              type="button"
              role="menuitem"
              disabled={!connected}
              title={offline}
              // In the same project: a new chat about this chat's agent, or a plain one when it has none.
              onClick={choose(() => sendCreateThread(thread.agent_id))}
              className={MENU_ROW}
            >
              <Icon.chatHeader.newChat size={ICON.sm} />
              <span className="min-w-0 flex-1 truncate">New Chat</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatHeader() {
  const name = useMachineName();
  const connection = useTraceStore((s) => s.connection);
  const thread = useThreadStore((s) => threadById(s.threads, s.activeThreadId));
  /** Which conversation's name is being edited — so opening another one ends the edit. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const connected = connection === "open";
  return (
    // The window's top edge, so it drags the window like the sidebar's own top row does.
    <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 px-4">
      {name && <MachineChip name={name} connection={connection} />}
      {name && <span aria-hidden className="h-5 w-px shrink-0 bg-hair" />}
      {thread ? (
        <div className="flex min-w-0 items-center gap-0.5">
          {/* KEYED BY THREAD, so opening another conversation mid-edit starts that one's title fresh
              rather than carrying a half-typed name across to it. */}
          <ThreadTitle
            key={thread.id}
            thread={thread}
            connected={connected}
            editing={renamingId === thread.id}
            onEditingChange={(on) => setRenamingId(on ? thread.id : null)}
          />
          <ThreadMenu thread={thread} connected={connected} onRename={() => setRenamingId(thread.id)} />
        </div>
      ) : (
        <span className="px-2 text-label text-muted">New chat</span>
      )}
    </div>
  );
}

// The three controls over the conversation, left to right: the computer it runs on, the chat's name,
// and what can be done to the chat.
//
// A BROWSER GETS NO COMPUTER. There is no machine to name there — `readMachineName` resolves to null —
// and "Connected" under an empty name would be a status about nothing. The title and its menu still show.

import { useEffect, useRef, useState } from "react";

import { chatMarkdown } from "../lib/chatMarkdown.ts";
import { useTypedText } from "../lib/typedText.ts";
import { chatTitle } from "../lib/chatTitle.ts";
import { readMachineName } from "../lib/hostMachine.ts";
import { Icon } from "../lib/icons/registry.ts";
import { useMenuFocus } from "../lib/menuFocus.ts";
import {
  sendArchiveThread, sendCreateThread, sendDeleteThread, sendRenameThread, sendRestoreThread,
} from "../lib/socket.ts";
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

/** Close a popover on a click outside it or on Escape, while it is open. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, ref, close]);
}

const CONNECTION_WORD: Record<ConnectionState, string> = {
  open: "Connected",
  connecting: "Connecting…",
  closed: "Disconnected",
};

const CONNECTION_DOT: Record<ConnectionState, string> = {
  open: "bg-ok",
  connecting: "bg-faint",
  closed: "bg-err",
};

const HEADER_BUTTON =
  "flex h-7 shrink-0 items-center justify-center rounded-control transition-colors duration-fast hover:bg-active/40 focus-visible:outline-none focus-visible:shadow-focusring";

const POPOVER =
  "absolute left-0 top-full z-50 mt-1 origin-top animate-menu-in rounded-card border border-edge bg-elevated shadow-floating motion-reduce:animate-none";

/**
 * The computer, as a button. Pressing it shows the name its owner gave it, and under that a dot and
 * a word for whether Jaroku can reach it right now.
 */
export function MachineButton({ name, connection }: { name: string; connection: ConnectionState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="This computer"
        title={name}
        onClick={() => setOpen((v) => !v)}
        className={`${HEADER_BUTTON} w-7 text-ink`}
      >
        <Icon.chatHeader.machine size={ICON.sm} />
      </button>
      {open && (
        <div role="dialog" aria-label="This computer" className={`${POPOVER} min-w-[220px] px-3 py-2.5`}>
          <div className="max-w-[280px] truncate text-label text-ink">{name}</div>
          <div className="mt-1 flex items-center gap-1.5 text-tiny text-muted" aria-live="polite">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${CONNECTION_DOT[connection]}`} />
            {CONNECTION_WORD[connection]}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The conversation's name, renamed where it stands.
 *
 * A CLICK TURNS IT INTO A TEXT BOX IN PLACE, and so does Rename in the menu beside it. Enter saves,
 * Escape puts the old name back. Leaving the box saves only a CHANGED name: saving marks the title as
 * chosen, which stops it being titled automatically, and a click in and out again is not a choice.
 * Enter on an unchanged name is one — the thread list's rename works the same way.
 *
 * ONLY FOR SOMEBODY WHO MAY RENAME, AND ONLY WHILE CONNECTED. Otherwise the name is plain text: a box
 * that took a new name over a dead socket would drop it without a word.
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
  // A NEW NAME TYPES ITSELF OUT — a topic title arriving — unless somebody typed it themselves.
  const shownTitle = useTypedText(chatTitle(thread.title), !thread.title_is_custom);
  const [draft, setDraft] = useState(chatTitle(thread.title));
  const input = useRef<HTMLInputElement>(null);
  /** Escape ended this edit, so the blur that follows must not save it. */
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    cancelled.current = false;
    setDraft(chatTitle(thread.title));
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
        <Truncate className="text-label text-ink" title={chatTitle(thread.title)}>{shownTitle}</Truncate>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      title="Rename this chat"
      className={`${HEADER_BUTTON} min-w-0 max-w-[360px] px-2 text-left`}
    >
      <Truncate className="text-label text-ink" title={chatTitle(thread.title)}>{shownTitle}</Truncate>
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
 *
 * DELETE ASKS FIRST, inside the menu, and says what goes and what stays. Archive is the reversible
 * one and needs no question; this is the one that cannot be undone.
 */
function ThreadMenu({ thread, connected, onRename }: { thread: ThreadView; connected: boolean; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useUiStore((s) => s.pinnedThreads.includes(thread.id));
  const archived = thread.archived_at !== null;
  const canRename = useCanRun("renameThread");
  const canArchive = useCanRun(archived ? "restoreThread" : "archiveThread");
  // Agent-scoped: whether this person may start a chat about THIS chat's agent, or a plain one.
  const canCreate = useCanRun("createThread", thread.agent_id);
  const canDelete = useCanRun("deleteThread");

  // `"mousedown"` and `"Escape"` are handled in `useDismiss`, which this menu shares with the computer's popover.
  useDismiss(open, ref, () => setOpen(false));
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A menu reopened on a delete question somebody walked away from would be asking it again unprompted.
  useEffect(() => { if (!open) setConfirming(false); }, [open]);
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

  const remove = (): void => {
    if (!sendDeleteThread(thread.id)) return;
    const ui = useUiStore.getState();
    if (ui.pinnedThreads.includes(thread.id)) ui.togglePinnedThread(thread.id);
    // The chat on screen is the one going, so the pane goes back to a new chat rather than to a row
    // that the next list snapshot will not contain.
    if (useThreadStore.getState().activeThreadId === thread.id) useThreadStore.getState().selectThread(null);
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
        className={`${HEADER_BUTTON} w-7 text-muted hover:text-ink`}
      >
        <Icon.chatHeader.menu size={ICON.sm} />
      </button>
      <span aria-live="polite" className="text-tiny text-muted">{note ?? ""}</span>

      {open && (
        <div role="menu" aria-label="Chat actions" className={`${POPOVER} min-w-[220px] overflow-hidden p-1`}>
          {confirming ? (
            <div className="flex max-w-[280px] flex-col gap-1.5 p-1.5">
              <p className="px-1 text-tiny leading-[1.5] text-muted">
                Delete <span className="text-ink">{chatTitle(thread.title)}</span> for good? Its messages go with it. Its
                agent, runs and costs stay.
              </p>
              <div className="flex gap-3 px-1 pb-0.5">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!connected}
                  title={offline}
                  onClick={choose(remove)}
                  className="text-tiny text-err underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-default disabled:text-disabled disabled:no-underline"
                >
                  Delete for good
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirming(false)}
                  className="text-tiny text-muted underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-focusring"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
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
              {canDelete && (
                <>
                  <div className="my-1 h-px bg-hair" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!connected}
                    title={offline}
                    onClick={() => setConfirming(true)}
                    className={`${MENU_ROW} text-err`}
                  >
                    <Icon.chatHeader.delete size={ICON.sm} />
                    <span className="min-w-0 flex-1 truncate">Delete</span>
                  </button>
                </>
              )}
            </>
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
    <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-1 px-4">
      {name && <MachineButton name={name} connection={connection} />}
      {/* NOTHING BESIDE THE COMPUTER UNTIL A CONVERSATION HAS STARTED. There is no name to show or
          rename and nothing for the menu to act on, so the computer stands alone. */}
      {thread && (
        <>
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
        </>
      )}
    </div>
  );
}

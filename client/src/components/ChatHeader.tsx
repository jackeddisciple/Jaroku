// The row over the conversation: the computer it runs on and whether it is connected, then the
// conversation's own name.
//
// A BROWSER GETS NO COMPUTER. There is no machine to name there — `readMachineName` resolves to null —
// and "Connected" under an empty name would be a status about nothing. The title still shows.

import { useEffect, useRef, useState } from "react";

import { readMachineName } from "../lib/hostMachine.ts";
import { Icon } from "../lib/icons/registry.ts";
import { sendRenameThread } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { threadById, useThreadStore } from "../store/threadStore.ts";
import { useTraceStore, type ConnectionState } from "../store/traceStore.ts";
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
 * A CLICK OPENS THE FIELD IN PLACE, Enter saves, Escape puts the old name back. Leaving the field
 * saves only a CHANGED name: saving marks the title as chosen, which stops it being titled
 * automatically, and a click in and out again is not a choice. Enter on an unchanged name is one —
 * the thread list's rename works the same way.
 *
 * ONLY FOR SOMEBODY WHO MAY RENAME, AND ONLY WHILE CONNECTED. Otherwise the name is plain text: a
 * field that took a new name over a dead socket would drop it without a word.
 */
export function ThreadTitle({ thread, connected }: { thread: ThreadView; connected: boolean }) {
  const canRename = useCanRun("renameThread");
  const [editing, setEditing] = useState(false);
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
    setEditing(false);
    if (cancelled.current) return;
    const next = draft.trim();
    if (!next) return;
    if (save === "if-changed" && next === thread.title) return;
    sendRenameThread(thread.id, next);
  };

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish("if-changed")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish("always");
          else if (e.key === "Escape") { cancelled.current = true; setEditing(false); }
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
      onClick={() => setEditing(true)}
      title="Rename this chat"
      className="flex h-7 min-w-0 max-w-[360px] items-center rounded-control px-2 text-left transition-colors duration-fast hover:bg-active/40 focus-visible:outline-none focus-visible:shadow-focusring"
    >
      <Truncate className="text-label text-ink" title={thread.title}>{thread.title}</Truncate>
    </button>
  );
}

export function ChatHeader() {
  const name = useMachineName();
  const connection = useTraceStore((s) => s.connection);
  const thread = useThreadStore((s) => threadById(s.threads, s.activeThreadId));
  return (
    // The window's top edge, so it drags the window like the sidebar's own top row does.
    <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 px-4">
      {name && <MachineChip name={name} connection={connection} />}
      {name && <span aria-hidden className="h-5 w-px shrink-0 bg-hair" />}
      {thread ? (
        // KEYED BY THREAD, so opening another conversation mid-edit starts that one's title fresh
        // rather than carrying a half-typed name across to it.
        <ThreadTitle key={thread.id} thread={thread} connected={connection === "open"} />
      ) : (
        <span className="px-2 text-label text-muted">New chat</span>
      )}
    </div>
  );
}

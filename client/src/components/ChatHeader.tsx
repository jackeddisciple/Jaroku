// The row over the conversation: the computer it runs on, and whether that computer is connected.
//
// A BROWSER GETS NO ROW. There is no machine to name there — `readMachineName` resolves to null — and
// a header reading "Connected" under an empty name would be a status about nothing.

import { useEffect, useState } from "react";

import { readMachineName } from "../lib/hostMachine.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { useTraceStore, type ConnectionState } from "../store/traceStore.ts";

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

export function ChatHeader() {
  const name = useMachineName();
  const connection = useTraceStore((s) => s.connection);
  if (!name) return null;
  return (
    // The window's top edge, so it drags the window like the sidebar's own top row does.
    <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 px-4">
      <MachineChip name={name} connection={connection} />
    </div>
  );
}

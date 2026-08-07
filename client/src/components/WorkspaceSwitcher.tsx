// Which workspace this tab is in, and how to change it.
//
// A switch is a new socket, not a mutation on the current one — see lib/socket.ts. From here
// that means the click does three things in a fixed order: close, empty every store, open
// again with a ticket for the other workspace. The user sees the app go briefly blank, which
// is honest: for that moment there genuinely is nothing to show.

import { useEffect, useRef, useState } from "react";
import { signOut, switchWorkspace } from "../lib/socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";

export function WorkspaceSwitcher() {
  const user = useSessionStore((s) => s.user);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const expiring = useSessionStore((s) => s.expiring);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Nothing to show before there is a session. The top bar renders during the connecting
  // state too, and an empty chip is quieter than a placeholder that flashes.
  if (!user || !workspaceId) return null;
  const current = workspaces.find((w) => w.id === workspaceId);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-hair hover:text-fg"
        title={`${user.email} — ${current?.role ?? ""}`}
      >
        <span className="max-w-[14ch] truncate text-fg">{current?.name ?? "workspace"}</span>
        {expiring && (
          // The token behind this socket is nearly out. Said quietly rather than as a modal:
          // nothing has failed yet, and the reconnect will renew it.
          <span className="text-[10px] text-amber-400" title="your session is about to end">
            ●
          </span>
        )}
        <span className="text-fg-dim">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-md border border-edge bg-bg shadow-overlay">
          <div className="border-b border-hair px-3 py-2">
            <div className="truncate text-xs text-fg">{user.displayName || user.email}</div>
            <div className="truncate text-[11px] text-fg-dim">{user.email}</div>
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setOpen(false);
                  switchWorkspace(w.id);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors hover:bg-hair"
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${w.id === workspaceId ? "text-fg" : "text-fg-dim"}`}>
                    {w.name}
                  </span>
                  <span className="block truncate text-[10px] text-fg-dim">{w.role}</span>
                </span>
                {w.id === workspaceId && <span className="ml-2 text-fg">✓</span>}
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            className="w-full border-t border-hair px-3 py-2 text-left text-xs text-fg-dim transition-colors hover:bg-hair hover:text-fg"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

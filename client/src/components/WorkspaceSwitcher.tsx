// Which workspace this tab is in, how to change it, and how to make another one.
//
// AT THE TOP OF THE SIDEBAR, ABOVE THE FOUR DESTINATIONS, and it used to be in the top bar's right
// group beside the provider chip. §9 gives the reason in one sentence: "deploying to the wrong
// workspace is the team-scale equivalent of rm -rf /". A workspace is the widest scope on screen —
// every agent, thread, secret and deployment in the window belongs to exactly one — and putting
// the name of that scope in the same cluster as the model picker filed it with the settings for
// one conversation. It spans the rail AND the column rather than sitting inside either, because
// both of them are inside it: the four destinations are views of this workspace, and the agent
// list beneath them is this workspace's agents.
//
// SO THERE IS EXACTLY ONE OF IT. The top bar's copy is gone rather than kept as a second door,
// which sounds like a loss of discoverability and is the opposite: two controls rendering one fact
// is two places to read the workspace from, and the failure §9 is about is somebody reading the
// wrong one.
//
// A switch is a new socket, not a mutation on the current one — see lib/socket.ts. From here
// that means the click does three things in a fixed order: close, empty every store, open
// again with a ticket for the other workspace. The user sees the app go briefly blank, which
// is honest: for that moment there genuinely is nothing to show.
//
// CREATING ONE IS AN HTTP REQUEST, not a command on this socket, and the reason is the same one
// that makes accepting an invitation HTTP: a socket is scoped to a workspace by its ticket, and
// this is the request that brings a workspace into existence. There is no scope for it to arrive
// in. See lib/auth.ts and server/src/auth/session.ts.
//
// AND UNTIL NOW THERE WAS NO WAY TO MAKE ONE AT ALL. `provisionUser` created a single personal
// workspace on first sign-in and nothing else ever created another — so the roles matrix, the
// invitation flow, the audit log and the Threads author column were all built behind a kind of
// workspace (`team`) that could only be obtained by setting an environment variable documented as
// naming which workspace the server acts in on its own behalf.

import { useEffect, useRef, useState } from "react";
import { createWorkspace, storedToken } from "../lib/auth.ts";
import { signOut, switchWorkspace } from "../lib/socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  CheckIcon, ChevronDownIcon, PlusIcon, UserCircleIcon, UserIcon, UsersIcon,
} from "./panelIcons.tsx";

/** The two kinds, in the terms that decide which one somebody wants. */
const KINDS: { id: "personal" | "team"; label: string; what: string }[] = [
  { id: "team", label: "Team", what: "Members, roles and invitations. Threads show who did what." },
  { id: "personal", label: "Personal", what: "Just you. No members list and no author column." },
];

function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "team">("team");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const wanted = name.trim();
    if (busy || !wanted) return;
    const token = storedToken();
    if (!token) {
      setError("sign in again — this tab has no credential");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createWorkspace(token, { name: wanted, kind });
      // The list the server answered with, which already contains the new workspace. Written
      // before the switch, because `switchWorkspace` refuses a workspace it cannot see a
      // membership for — and this account became its owner a millisecond ago.
      useSessionStore.getState().setWorkspaces(created.workspaces);
      onDone();
      switchWorkspace(created.workspace.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-hair px-3 py-2.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
        placeholder="workspace name"
        className="w-full rounded-control border border-hair bg-void px-2 py-1.5 text-[12px] text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
      />
      {/* THE KIND IS ASKED, NEVER DEFAULTED SILENTLY. It decides whether the workspace has a
          members list, roles and an author column at all, and it is not changeable afterwards —
          so a control that guessed would be guessing about the one irreversible field. */}
      <div className="mt-2 flex gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            title={k.what}
            className={`flex-1 rounded-control px-2 py-1 text-[11px] transition-colors ${
              kind === k.id ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-[1.5] text-faint">{KINDS.find((k) => k.id === kind)?.what}</p>
      {error && <p className="mt-1.5 text-[11px] text-err">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || name.trim().length === 0}
          className="rounded-control bg-panel px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onDone} className="px-1 text-[11px] text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function WorkspaceSwitcher() {
  const user = useSessionStore((s) => s.user);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const expiring = useSessionStore((s) => s.expiring);
  const openWorkspacePanel = useUiStore((s) => s.openWorkspacePanel);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
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

  // The form is per-opening, not per-tab. A half-typed name left behind a dismissed menu would
  // reappear the next time somebody came to switch workspace, which is not what they asked for.
  useEffect(() => {
    if (!open) setCreating(false);
  }, [open]);

  // Nothing to show before there is a session. The sidebar renders during the connecting state
  // too, and an empty row is quieter than a placeholder that flashes into somebody else's
  // workspace name. A fixed height, so the four destinations beneath it do not jump when the
  // session lands.
  if (!user || !workspaceId) return <div className="h-9 shrink-0 border-b border-hair" />;
  const current = workspaces.find((w) => w.id === workspaceId);
  const KindIcon = current?.kind === "team" ? UsersIcon : UserIcon;

  return (
    <div ref={ref} className="relative shrink-0 border-b border-hair">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // THE MOST PROMINENT TEXT IN THE SIDEBAR — §9.1: larger than the tab labels, smaller than
        // a page title. 13px against the 12px the agent rows and the account row use, which is one
        // step and is enough: this is the thing every other row in the column is scoped BY, and a
        // heading twice the size of its list would be a banner.
        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-active/40 active:bg-chrome focus-visible:outline-none focus-visible:shadow-focusring ${
          open ? "bg-active/40" : ""
        }`}
        title={`${current?.name ?? "workspace"} — ${current?.kind ?? ""}, you are ${current?.role ?? "a member"}`}
      >
        {/* THE KIND, BESIDE THE NAME. `kind` is the field that cannot change after creation and it
            decides whether the members list, the roles and the Threads author column exist at all
            — so the one place it is always visible is beside the name it qualifies. */}
        <span className="shrink-0 text-muted" aria-hidden>
          <KindIcon size={ICON.sm} />
        </span>
        <Truncate className="min-w-0 flex-1 text-[13px] text-ink" title={current?.name}>
          {current?.name ?? "workspace"}
        </Truncate>
        {expiring && (
          // The token behind this socket is nearly out. Said quietly rather than as a modal:
          // nothing has failed yet, and the reconnect will renew it.
          <span className="shrink-0 text-[10px] text-run" title="your session is about to end">
            ●
          </span>
        )}
        {/* THE PLAN, FROM THE SESSION, NEVER MAPPED HERE. `planFor` on the server is the same
            function the budget gate resolves limits through, so the chip in this row and the figure
            in the Usage panel are one computation — see the footer's own note for the paid
            workspace that read "Free" in one place and "Pro" in the other. */}
        {current?.plan?.label && (
          <Chip caps size="sm" tone="faint" className="shrink-0">{current.plan.label}</Chip>
        )}
        <span className="shrink-0 text-faint" aria-hidden><ChevronDownIcon size={ICON.xs} /></span>
      </button>

      {open && (
        <div className="absolute left-2 right-2 z-30 mt-1 w-auto animate-slide-in overflow-hidden rounded-card border border-edge bg-panel p-1 shadow-floating motion-reduce:animate-none">
          <div className="border-b border-hair px-3 py-2">
            <div className="truncate text-[12px] text-ink">{user.displayName || user.email}</div>
            <div className="truncate text-[11px] text-faint">{user.email}</div>
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setOpen(false);
                  switchWorkspace(w.id);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-active active:bg-chrome"
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${w.id === workspaceId ? "text-ink" : "text-muted"}`}>
                    {w.name}
                  </span>
                  {/* The KIND beside the role, because it is what decides whether the members and
                      author surfaces exist in that workspace at all. */}
                  <span className="block truncate text-[10px] text-faint">{w.role} · {w.kind}</span>
                </span>
                {w.id === workspaceId && <span className="ml-2 text-ink"><CheckIcon size={ICON.xs} /></span>}
              </button>
            ))}
          </div>

          {/* MEMBERS IS HERE rather than in the sidebar's settings block, because this is where a
              workspace is already the subject. Offered for a personal workspace too: the roles all
              work there, and hiding the list would make "invite somebody" undiscoverable in the
              only workspace most accounts have. */}
          <button
            onClick={() => {
              setOpen(false);
              openWorkspacePanel("members");
            }}
            className="flex w-full items-center gap-2 border-t border-hair px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            <UserCircleIcon size={ICON.xs} /> Members and invitations
          </button>

          {creating ? (
            <NewWorkspaceForm onDone={() => setOpen(false)} />
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 border-t border-hair px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
            >
              <PlusIcon size={ICON.xs} /> New workspace
            </button>
          )}

          <button
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            className="w-full border-t border-hair px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

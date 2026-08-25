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
import { acceptInvite, createWorkspace, storedToken } from "../lib/auth.ts";
import { switchWorkspace } from "../lib/socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { inviteTokenFromInput } from "../lib/invite.ts";
import { orderWorkspaces, roleLabel, shouldScroll } from "../lib/workspaceList.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, PlusIcon, SettingsIcon, TicketIcon, UserIcon,
  UsersIcon, XIcon,
} from "./panelIcons.tsx";

/**
 * §3.2's two options, in §3.2's own words.
 *
 * TEAM FIRST AND PRE-SELECTED, which is what the spec asks for and is also the only order that
 * survives the edge case beneath it: an account that already has a personal workspace — every
 * account, since `provisionUser` makes one in the same transaction as the user — never sees the
 * second row at all, so a list with Personal first would be a list whose first entry is usually
 * absent and whose selection therefore usually starts on the second.
 */
const KINDS: { id: "personal" | "team"; label: string; what: string }[] = [
  { id: "team", label: "Team", what: "Invite your team, shared agents and billing" },
  { id: "personal", label: "Personal", what: "Just you, no members" },
];

/** §3.2 — 1-64 characters, non-empty after trim. The server bounds it identically. */
const NAME_MAX = 64;

function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "team">("team");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaces = useSessionStore((s) => s.workspaces);

  /**
   * §3.3 — "A user cannot create a second personal workspace. The button is ABSENT (not disabled)
   * if they already have one."
   *
   * ABSENT RATHER THAN DISABLED is §1.3's frozen rule about controls a role cannot use, applied to
   * a control an ACCOUNT cannot use, and it is the right reading for the same reason: a disabled
   * "Personal" is an offer the product is refusing, which invites somebody to work out what would
   * enable it. There is no such state — every account has exactly one personal workspace from the
   * moment it exists — so the honest rendering is that the choice was never on the table.
   *
   * THE SERVER DOES NOT REFUSE THIS, and that is deliberate rather than a hole left open. §16 says
   * to stop and ask before adding server-side business logic beyond §13's list, and this is not on
   * it. What happens if something posts `kind: "personal"` twice anyway is a second personal
   * workspace, which `defaultWorkspace` already tolerates: it takes the oldest, stably, so the
   * account still lands where it always did.
   */
  const hasPersonal = workspaces.some((w) => w.kind === "personal");
  const offered = KINDS.filter((k) => k.id !== "personal" || !hasPersonal);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // §3.3 — trimmed before it is sent, and the same trimmed value is what was validated. Sending
    // the untrimmed one would mean a workspace called " Acme" whose name does not match the string
    // this form checked the length of.
    const wanted = name.trim();
    if (busy || !wanted || wanted.length > NAME_MAX) return;
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
      // §3.4 AND §5.1 STEP 7 — "the Inbox for a first visit to this workspace", and a workspace
      // that did not exist a moment ago is the clearest first visit there is. It lands on two
      // seeded items (`setup_api_key`, `setup_first_agent`) which are the entire content of a new
      // team workspace; the Threads tab somebody would otherwise land on is empty by definition.
      // Set BEFORE the switch, because `uiStore` is deliberately not reset by one — see reset.ts.
      useUiStore.getState().openNav("inbox");
      onDone();
      switchWorkspace(created.workspace.id);
    } catch (err) {
      // §3.5 — INLINE, AND THE FORM STAYS OPEN. `AuthFailure` already separates "could not reach
      // the server" from "the server refused", so an offline create says so rather than spinning:
      // `busy` is cleared here and only here, which is what makes every failure end the spinner.
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const trimmed = name.trim();
  return (
    // §3.1 — IT REPLACES THE DROPDOWN'S CONTENT. Not a modal and not a page: the thing being named
    // is the thing the menu above it lists, and a modal would cover the list somebody is about to
    // see their new workspace appear in.
    <form onSubmit={submit} className="border-t border-hair px-3 py-2.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={NAME_MAX}
        placeholder="My team"
        aria-label="Workspace name"
        className="w-full rounded-control border border-hair bg-void px-2 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
      />
      {/* THE KIND IS ASKED, NEVER DEFAULTED SILENTLY. It decides whether the workspace has a
          members list, roles and an author column at all, and it is not changeable afterwards —
          so a control that guessed would be guessing about the one irreversible field. */}
      {offered.length > 1 && (
        <div className="mt-2 flex gap-1">
          {offered.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              title={k.what}
              className={`flex-1 rounded-control px-2 py-1 text-tiny transition-colors ${
                kind === k.id ? "bg-active text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      {/* §3.2's one-line description, which is the row's whole job: "Team" and "Personal" are two
          words that mean nothing to somebody who has not read the tenancy model. Rendered even
          when there is only one option left, because that is exactly the case where the label is
          alone and unexplained. */}
      <p className="mt-1.5 text-tiny leading-[1.5] text-faint">{KINDS.find((k) => k.id === kind)?.what}</p>
      {error && <p role="alert" className="mt-1.5 text-tiny text-err">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || trimmed.length === 0}
          className="rounded-control bg-panel px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onDone} className="px-1 text-tiny text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * §4.1.2 — redeeming an invitation somebody pasted rather than clicked.
 *
 * THE DEEP LINK IS NOT BEING REPLACED. `<origin>/?invite=<token>` still works end to end and is
 * still the path an inviter should use; this is the other end of the same string, for the case the
 * spec names — a code pasted into Slack or an email, arriving as text rather than as something to
 * click. See lib/invite.ts, which both paths share.
 *
 * HTTP, NOT A COMMAND, and it is the same route the deep link uses. §4.1.2 offers either "the
 * acceptInvite command (or the HTTP equivalent if the user has no socket yet — check how the
 * existing deep-link path does it)", and the existing path is HTTP for a reason that applies here
 * unchanged: a socket is scoped to a workspace by its ticket, and this tab's socket is scoped to
 * the workspace somebody is currently in, not to the one they are joining. There is no scope for a
 * `acceptInvite` command to arrive in.
 */
function JoinWorkspaceForm({ onDone }: { onDone: () => void }) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    // §4.1.2's third failure — "Invalid invite code" — ANSWERED WITHOUT A ROUND TRIP, because it
    // is the one of the three that is a fact about the string rather than about an invitation. A
    // truncated paste sent as a redemption comes back as "that invitation is not valid", which
    // reads as the invitation being wrong and sends somebody back to whoever sent it.
    const token = inviteTokenFromInput(pasted);
    if (!token) {
      setError("That does not look like an invite code. Paste the whole link, or the code after it.");
      return;
    }
    const bearer = storedToken();
    if (!bearer) {
      setError("sign in again — this tab has no credential");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const joined = await acceptInvite(bearer, token);
      useSessionStore.getState().setWorkspaces(joined.workspaces);
      // §4.1.2's "brief toast", on the surface the deep-link path already announces itself
      // through. One notice for two ways of arriving, rather than a second toast system whose
      // only difference is which of the two produced it.
      useUiStore.getState().setInviteNotice({
        ok: true,
        message: `Joined ${joined.workspace.name}`,
      });
      // A workspace somebody has this second become a member of is a first visit by definition —
      // §5.1 step 7. The same landing the create flow makes, and for the same reason: the Threads
      // tab of a workspace you have never opened is a list of other people's work.
      useUiStore.getState().openNav("inbox");
      onDone();
      switchWorkspace(joined.workspace.id);
    } catch (err) {
      // §4.1.2 ASKS FOR THREE MESSAGES AND THE SERVER CLASSIFIES TWO OF THEM TOGETHER, which is a
      // deliberate refusal rather than a gap: `acceptInvite` answers "expired or no longer valid"
      // for expired, revoked, already-used and invented alike, because telling the holder of a
      // link which one it is tells somebody holding a STOLEN link whether it was ever real. The
      // spec says these "map to the server's existing failure classification", so this maps to
      // what the classification actually is — the malformed case above, the server's sentence
      // here, and the two it does distinguish (already a member, addressed to somebody else).
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-hair px-3 py-2.5">
      <input
        autoFocus
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="Paste invite code"
        aria-label="Invite code or link"
        // `spellCheck` off and no autocapitalise: this is a base64url secret, and a phone that
        // capitalises its first character produces a token whose digest matches nothing, with
        // "that invitation is not valid" as the only symptom.
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="w-full rounded-control border border-hair bg-void px-2 py-1.5 text-tiny text-ink placeholder:font-sans placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
      />
      <p className="mt-1.5 text-tiny leading-[1.5] text-faint">
        The whole link or just the code after it — either works.
      </p>
      {error && <p role="alert" className="mt-1.5 text-tiny leading-[1.5] text-err">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || pasted.trim().length === 0}
          className="rounded-control bg-panel px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Joining…" : "Join"}
        </button>
        <button type="button" onClick={onDone} className="px-1 text-tiny text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A text row at the foot of the menu. §2.2: these are rows, not buttons. */
function MenuRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: (p: { size?: number }) => React.ReactElement;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-caption text-muted transition-colors hover:bg-active/40 active:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
    >
      <span className="shrink-0" aria-hidden><Icon size={ICON.xs} /></span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function WorkspaceSwitcher() {
  const user = useSessionStore((s) => s.user);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const expiring = useSessionStore((s) => s.expiring);
  const switchError = useSessionStore((s) => s.switchError);
  const clearSwitchError = useSessionStore((s) => s.clearSwitchError);
  const openWorkspacePanel = useUiStore((s) => s.openWorkspacePanel);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // §2.2's order, computed here rather than in the map, so the list the rows are drawn from and
  // the list the arrow keys walk are the same array by construction.
  const ordered = orderWorkspaces(workspaces);

  /**
   * §2.3's three ways out and the arrow keys, on ONE listener.
   *
   * ROVING DOM FOCUS OVER THE ROWS, not an index in React state — which is the "extends the
   * existing binding layer, not a second one" the spec asks for, spelled the way `composer/
   * Popover.tsx` already spells it. The difference is not stylistic: an index has to be kept in
   * step with a list that changes under it (a workspace created, a form replacing the rows), and
   * every one of those is a place for the highlight to point at a row that has moved. Focus cannot
   * drift, `Enter` is already the browser's activation for a focused button, and the focus ring is
   * the highlight — so there is nothing to draw and nothing to reset.
   *
   * `Enter` IS THEREFORE ABSENT FROM THIS HANDLER, deliberately. A row is a `<button>`; the
   * platform activates it. Adding a key handler for it would be a second activation path that can
   * disagree with the first — and the one it would disagree with is the one screen readers use.
   */
  useEffect(() => {
    if (!open) return;
    const rows = (): HTMLElement[] =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      // A FIELD INSIDE THE MENU KEEPS ITS OWN ARROWS. The create form replaces the rows with a
      // text input, and stealing ArrowUp from it would stop somebody moving the caret in the name
      // they are typing. Same guard, same reason, as the popover's.
      const active = document.activeElement as HTMLElement | null;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const items = rows();
      if (items.length === 0) return;
      e.preventDefault();
      const at = active ? items.indexOf(active) : -1;
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1
        // Wrapping, because a menu of four rows should not require knowing which end you are at.
        : e.key === "ArrowDown" ? (at + 1) % items.length
        : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus back to the trigger when the menu closes, so a keyboard user is not dropped at the top
  // of the document by a row that has just been removed from it. In its own effect rather than in
  // every path that closes, because there are four of them — a selection, Escape, an outside
  // click, and the create form finishing — and each would have to remember.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // The form is per-opening, not per-tab. A half-typed name left behind a dismissed menu would
  // reappear the next time somebody came to switch workspace, which is not what they asked for.
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setJoining(false);
    }
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
        ref={triggerRef}
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
        <Truncate className="min-w-0 flex-1 text-label text-ink" title={current?.name}>
          {current?.name ?? "workspace"}
        </Truncate>
        {expiring && (
          // The token behind this socket is nearly out. Said quietly rather than as a modal:
          // nothing has failed yet, and the reconnect will renew it.
          <span className="shrink-0 text-tiny text-run" title="your session is about to end">
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

      {/* §5.2 — "show an error inline in the switcher and revert to the previous workspace".
          BENEATH THE ROW RATHER THAN INSIDE THE DROPDOWN, because by the time it exists the
          dropdown has closed: the click that started the switch closed it, and a message that only
          appears when somebody reopens the menu is a message about something they have already
          concluded did not work. The name above it is the workspace they are back in, which is the
          other half of what they need to know. */}
      {switchError && (
        <div role="alert" className="flex items-start gap-2 border-t border-hair bg-err/5 px-3 py-1.5">
          <span className="mt-0.5 shrink-0 text-err" aria-hidden><AlertTriangleIcon size={ICON.xs} /></span>
          <span className="min-w-0 flex-1 text-tiny leading-[1.5] text-err">{switchError}</span>
          <button
            onClick={clearSwitchError}
            title="Dismiss"
            aria-label="Dismiss"
            className="shrink-0 text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <XIcon size={ICON.xs} />
          </button>
        </div>
      )}

      {open && (
        <div
          role="menu"
          className="absolute left-2 right-2 z-30 mt-1 w-auto animate-slide-in overflow-hidden rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none"
        >
          {/* THE LIST SCROLLS ONLY WHEN IT HAS TO — §2.3. A `max-h` applied unconditionally would
              put a scrollbar on a menu of three and, worse, would push the two actions below the
              fold on exactly the account that has no workspaces to switch between and therefore
              needs "Create" and "Join" most. */}
          <div className={`py-1 ${shouldScroll(ordered.length) ? "max-h-64 overflow-y-auto" : ""}`}>
            {ordered.map((w) => {
              const active = w.id === workspaceId;
              const RowKind = w.kind === "team" ? UsersIcon : UserIcon;
              return (
                <button
                  key={w.id}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    switchWorkspace(w.id);
                  }}
                  // A CHECKMARK, NOT A CHECKMARK AND A HIGHLIGHT — §2.2 asks for one or the other
                  // and the reason is worth keeping: a filled row plus a tick states the same fact
                  // twice, and the second statement is the one that makes a quiet menu loud. The
                  // row is `text-ink` against the others' `text-muted`, which is "visually distinct
                  // but not loud" without a background.
                  className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-caption transition-colors hover:bg-active/40 active:bg-chrome focus-visible:outline-none focus-visible:shadow-focusring"
                >
                  <span className={`shrink-0 ${active ? "text-ink" : "text-faint"}`} aria-hidden>
                    <RowKind size={ICON.xs} />
                  </span>
                  <Truncate className={`min-w-0 flex-1 ${active ? "text-ink" : "text-muted"}`} title={w.name}>
                    {w.name}
                  </Truncate>
                  {/* THE ROLE, AND ONLY WHERE IT MEANS SOMETHING. A personal workspace has one
                      member and no roles to distinguish — §5.5 and §9.4 both say those surfaces do
                      not exist there — so an "Owner" badge on it would be a badge for a
                      distinction the workspace does not make. */}
                  {w.kind === "team" && (
                    <Chip size="sm" tone="faint" variant="bare" className="shrink-0">{roleLabel(w.role)}</Chip>
                  )}
                  {w.plan?.label && (
                    <Chip caps size="sm" tone="faint" className="shrink-0">{w.plan.label}</Chip>
                  )}
                  <span className={`shrink-0 ${active ? "text-ink" : "text-transparent"}`} aria-hidden>
                    <CheckIcon size={ICON.xs} />
                  </span>
                </button>
              );
            })}
          </div>

          {/* WHAT IS DELIBERATELY NOT ON THESE ROWS: an unread count from the Inbox. §2.2 offers it
              "only if you've implemented an unread-count-per-workspace endpoint", and there is no
              such endpoint — `counts.badge` is computed for the ONE workspace this socket is in,
              and a socket is scoped to a workspace by its ticket, so the number for the others is
              not a value this tab is holding. The spec's own instruction for that case is the one
              followed here: skip it and say so, rather than render a zero that looks like an
              answer. */}

          {creating ? (
            <NewWorkspaceForm onDone={() => setOpen(false)} />
          ) : joining ? (
            <JoinWorkspaceForm onDone={() => setOpen(false)} />
          ) : (
            // §2.2 — TEXT ROWS, NOT BUTTONS. They sit at the bottom of a menu whose other rows are
            // all destinations, and filled buttons there would read as the menu's primary actions
            // rather than as the things you do when none of the rows above is what you wanted.
            <div className="border-t border-hair">
              <MenuRow icon={PlusIcon} label="Create workspace" onClick={() => setCreating(true)} />
              <MenuRow icon={TicketIcon} label="Join workspace" onClick={() => setJoining(true)} />
              {/* SETTINGS FOR THE ACTIVE WORKSPACE — §6.1 and §10.1's entry point, on the row
                  group rather than on the active workspace's own row. A gear inside a row whose
                  whole job is "switch to this" would be a second target inside a click target,
                  and the only workspace whose settings can be opened is the one this socket is
                  in: the panel reads members, invitations, billing and the audit log over THIS
                  socket, and there is no socket in the others. */}
              <MenuRow
                icon={SettingsIcon}
                label={`${current?.name ?? "Workspace"} settings`}
                onClick={() => {
                  setOpen(false);
                  openWorkspacePanel("general");
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Everything that is true about the WORKSPACE rather than about an agent in it.
//
// WHY A PANEL OF ITS OWN, AND WHY AN OVERLAY. The right panel's ten tabs are all about one agent:
// its graph, its trace, its datasets, its deployment, where its code goes. None of that is the
// scope these sections work at — who may be here, what the workspace is paying, what it has done,
// what happens when it is deleted — and a tab beside `GitHub` would put "delete this workspace"
// one click from "look at this agent's diff".
//
// It is a modal over the shell for the reason the provider popover is not part of the top bar: it
// is opened deliberately, read, and dismissed. Nothing behind it needs to keep changing while it
// is up, and nothing in it is a live feed.
//
// SECTIONS ARE THE `section` FIELD ON THE STORE, not local state, because every one of them has a
// second door: the members list is reached from the workspace switcher, and later sections are
// reached from the surfaces that name the thing they change. A caller says which section it means,
// so a control never opens a panel that then has to be navigated.

import { useEffect, useRef, useState } from "react";
import {
  sendInviteMember, sendListMembers, sendRemoveMember, sendRevokeInvite, sendSetMemberRole,
} from "../lib/socket.ts";
import { inviteUrl } from "../lib/invite.ts";
import { useMemberStore, type Invite, type Member } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore, type WorkspaceSection } from "../store/uiStore.ts";
import { fmtUntil } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { AlertTriangleIcon, CheckIcon, UserCircleIcon, XIcon } from "./panelIcons.tsx";

const SECTIONS: { id: WorkspaceSection; label: string }[] = [{ id: "members", label: "Members" }];

/**
 * The three roles, with what each one actually decides.
 *
 * The words are the capability matrix's own split, in the sentences somebody choosing between them
 * would use: `member` is the product, `admin` is everything that commits the workspace to
 * something outside itself, `owner` is the workspace's own existence and who is in it.
 */
const ROLES: { id: string; label: string; what: string }[] = [
  { id: "member", label: "Member", what: "Build, run, edit and evaluate agents" },
  { id: "admin", label: "Admin", what: "…and connect keys, servers, repositories and deployments" },
  { id: "owner", label: "Owner", what: "…and membership, billing, and the workspace itself" },
];

/** The invite link, which exists exactly once and is gone when this is dismissed. */
function InviteLink() {
  const link = useMemberStore((s) => s.inviteLink);
  const dismiss = useMemberStore((s) => s.dismissInviteLink);
  const [copied, setCopied] = useState(false);
  if (!link) return null;
  const url = inviteUrl(window.location.origin, link.token);

  return (
    <div className="mt-2 rounded-control border border-run/40 bg-run/5 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-run"><AlertTriangleIcon size={ICON.xs} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink">
            Send this to {link.email}. It is shown once — only a hash of it is stored here, so
            dismissing this loses it and the invitation has to be reissued.
          </p>
          {/* SELECTABLE AND WRAPPED rather than truncated. It is a credential somebody has to get
              out of this box by hand, and a middle-elided link cannot be read back if the copy
              button is the thing that failed. */}
          <p className="mt-1.5 break-all rounded-chip bg-void px-2 py-1.5 font-mono text-[11px] text-muted select-all">
            {url}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              className={secondaryBtn}
              onClick={() => {
                // `navigator.clipboard` is unavailable on an insecure origin and refusable
                // anywhere. The link above is selectable for exactly that case, so a failure here
                // says nothing at all rather than raising an error about a convenience.
                void navigator.clipboard?.writeText(url).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? <CheckIcon size={ICON.xs} /> : null}
              {copied ? "Copied" : "Copy link"}
            </button>
            <span className="text-[11px] text-faint">expires {fmtUntil(link.expiresAt)}</span>
            <button className={`${quietBtn} ml-auto`} onClick={dismiss}>Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MemberRow({ member, canManage, isSelf }: { member: Member; canManage: boolean; isSelf: boolean }) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="flex items-center gap-2 border-b border-hair px-1 py-2 last:border-b-0">
      <span className="shrink-0 text-faint"><UserCircleIcon size={ICON.sm} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Truncate className="text-[12px] text-ink" title={member.email}>
            {member.display_name || member.email}
          </Truncate>
          {isSelf && <Chip size="sm" tone="faint" variant="bare">you</Chip>}
        </div>
        {member.display_name && (
          <Truncate className="text-[11px] text-faint" title={member.email}>{member.email}</Truncate>
        )}
      </div>

      {/* THE ROLE IS THE CONTROL, not a label with a control beside it. A select that shows the
          current role is one element saying what is true and offering the change; a label plus an
          "Edit" button is two, and the second one only ever opens the first. */}
      {canManage ? (
        <select
          value={member.role}
          onChange={(e) => sendSetMemberRole(member.user_id, e.target.value)}
          className="shrink-0 rounded-control border border-hair bg-panel px-1.5 py-1 text-[11px] text-ink outline-none"
          title={ROLES.find((r) => r.id === member.role)?.what}
        >
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      ) : (
        <Chip size="sm" tone="faint">{member.role}</Chip>
      )}

      {canManage && (
        confirmRemove ? (
          <button
            autoFocus
            onBlur={() => setConfirmRemove(false)}
            onClick={() => {
              sendRemoveMember(member.user_id);
              setConfirmRemove(false);
            }}
            className="shrink-0 rounded-control border border-err/40 bg-err/10 px-2 py-1 text-[11px] text-err"
          >
            Remove?
          </button>
        ) : (
          <button
            onClick={() => setConfirmRemove(true)}
            title={isSelf ? "Leave this workspace" : `Remove ${member.email}`}
            className="shrink-0 rounded-control px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-active hover:text-err"
          >
            <XIcon size={ICON.xs} />
          </button>
        )
      )}
    </div>
  );
}

function InviteRow({ invite, canManage }: { invite: Invite; canManage: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-hair px-1 py-2 last:border-b-0">
      <span className="shrink-0 text-faint"><UserCircleIcon size={ICON.sm} /></span>
      <div className="min-w-0 flex-1">
        <Truncate className="text-[12px] text-muted" title={invite.email}>{invite.email}</Truncate>
        <span className="text-[11px] text-faint">invited · expires {fmtUntil(invite.expires_at)}</span>
      </div>
      <Chip size="sm" tone="faint">{invite.role}</Chip>
      {canManage && (
        <button
          onClick={() => sendRevokeInvite(invite.id)}
          title="Revoke this invitation"
          className="shrink-0 rounded-control px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-active hover:text-err"
        >
          <XIcon size={ICON.xs} />
        </button>
      )}
    </div>
  );
}

function MembersSection() {
  const members = useMemberStore((s) => s.members);
  const invites = useMemberStore((s) => s.invites);
  const loaded = useMemberStore((s) => s.loaded);
  const error = useMemberStore((s) => s.error);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const workspaces = useSessionStore((s) => s.workspaces);
  const userId = useSessionStore((s) => s.user?.id ?? null);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  // OFFERED FROM THE ROLE THIS TAB HOLDS, and refused again by the server. Hiding what an owner
  // may do is honesty about what the next click will achieve, never the enforcement — see the
  // capability matrix, which is the only thing that decides.
  const canManage = workspace?.role === "owner";

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");

  // Asked for on open, not held. The relay pushes the list in its initial snapshot for a team
  // workspace and re-broadcasts on every mutation, so this is the one case it cannot cover: a
  // personal workspace, where the snapshot deliberately sends nothing.
  useEffect(() => {
    sendListMembers();
  }, [workspaceId]);

  const invite = (e: React.FormEvent): void => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    sendInviteMember(address, role);
    setEmail("");
  };

  return (
    <div className="space-y-4">
      {/* WHAT KIND OF WORKSPACE THIS IS, above the list, because it is what the list means. A
          personal workspace with a second member is not a thing the product forbids — the roles
          all work — but §6's collaboration rules and the author column are written for a team, and
          somebody inviting a colleague into a workspace called "personal" should see that. */}
      <div className="flex items-center gap-2">
        <span className={TYPE.sectionLabel}>{workspace?.name ?? "This workspace"}</span>
        <Chip size="sm" tone="faint" caps>{workspace?.kind ?? "workspace"}</Chip>
        {workspace?.kind === "personal" && (
          <span className="text-[11px] text-faint">
            Threads show no author column in a personal workspace
          </span>
        )}
      </div>

      {canManage && (
        <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="colleague@example.com"
            className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 text-[12px] text-ink placeholder:text-faint outline-none focus:border-edge"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="rounded-control border border-hair bg-panel px-2 py-1.5 text-[12px] text-ink outline-none"
          >
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          <button type="submit" className={primaryBtn} disabled={email.trim().length === 0}>
            Invite
          </button>
        </form>
      )}
      {canManage && (
        <p className="-mt-2 text-[11px] leading-[1.55] text-faint">
          {ROLES.find((r) => r.id === role)?.what}. There is no mail sender here — you get a link to
          send, once.
        </p>
      )}

      <InviteLink />

      {error && (
        <p className="rounded-control border border-err/30 px-2 py-1.5 text-[11px] text-err">{error}</p>
      )}

      <div>
        <div className="flex items-center px-1 pb-1">
          <span className={TYPE.panelLabel}>Members</span>
          <span className="ml-auto text-[11px] text-faint">{members.length}</span>
        </div>
        {members.length === 0 ? (
          <EmptyState
            size="inline"
            icon={UserCircleIcon}
            title={loaded ? "Nobody here yet" : "Loading…"}
            hint={loaded && canManage ? "Invite somebody above." : undefined}
          />
        ) : (
          members.map((m) => (
            <MemberRow
              key={m.user_id}
              member={m}
              canManage={canManage}
              isSelf={m.user_id === userId}
            />
          ))
        )}
      </div>

      {/* INVITATIONS ARE A SECOND LIST rather than greyed rows in the first. They are not members:
          nobody has accepted, the row has no user and no name, and the only action on it is to take
          it back. Mixed in, the count above would say "4 members" when two of them are letters
          nobody has opened. */}
      {invites.length > 0 && (
        <div>
          <div className="flex items-center px-1 pb-1">
            <span className={TYPE.panelLabel}>Invited</span>
            <span className="ml-auto text-[11px] text-faint">{invites.length}</span>
          </div>
          {invites.map((i) => (
            <InviteRow key={i.id} invite={i} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspacePanel() {
  const section = useUiStore((s) => s.workspaceSection);
  const open = useUiStore((s) => s.openWorkspacePanel);
  const close = useUiStore((s) => s.closeWorkspacePanel);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!section) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [section, close]);

  if (!section) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-void/70 p-8"
      // Dismissed by the backdrop as well as by Escape. Nothing here is a form somebody is
      // halfway through except the invite box, and that costs an email address to retype.
      onMouseDown={(e) => {
        if (!card.current?.contains(e.target as Node)) close();
      }}
    >
      <div
        ref={card}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-modal border border-edge bg-bg shadow-overlay"
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 py-2.5">
          <span className={TYPE.panelLabel}>Workspace</span>
          <div className="ml-3 flex items-center gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => open(s.id)}
                className={`rounded-control px-2.5 py-1 text-[12px] transition-colors ${
                  section === s.id ? "bg-active text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={close}
            title="Close (Escape)"
            className="ml-auto rounded-control px-1.5 py-1 text-faint transition-colors hover:bg-active hover:text-ink"
          >
            <XIcon size={ICON.sm} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <MembersSection />
        </div>
      </div>
    </div>
  );
}

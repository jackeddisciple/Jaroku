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
  sendInviteMember, sendListAudit, sendListMembers, sendRemoveMember, sendRevokeInvite,
  sendSetMemberRole,
} from "../lib/socket.ts";
import { inviteUrl } from "../lib/invite.ts";
import {
  deleteWorkspace, startWorkspaceExport, workspaceExportStatus,
  type DeletionReceipt, type ExportStatus,
} from "../lib/workspaceApi.ts";
import { useAuditStore } from "../store/auditStore.ts";
import { useMemberStore, type Invite, type Member } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore, type WorkspaceSection } from "../store/uiStore.ts";
import { AccountSection } from "./AccountSection.tsx";
import { absTime, fmtUntil, isExpired, relTime } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  ActivityIcon, AlertTriangleIcon, CheckIcon, UserCircleIcon, XIcon,
} from "./panelIcons.tsx";
import { Select } from "./Select.tsx";
import { BillingSection } from "./BillingSection.tsx";
import { UpsellCard } from "./UpsellCard.tsx";

const SECTIONS: { id: WorkspaceSection; label: string }[] = [
  { id: "members", label: "Members" },
  // Beside Members because most of what it records is membership, and because the two answer
  // the same question at different tenses: who is here, and what has been done here.
  { id: "audit", label: "Audit" },
  // What the workspace is PAYING, which this file's own header named as one of the four scopes
  // this panel exists for. Beside Members because seats are a membership question at the moment
  // somebody buys them, and before Data because it is read far more often than it is acted on.
  { id: "billing", label: "Billing" },
  // Last, and deliberately: it is the section with the irreversible button in it.
  { id: "data", label: "Data" },
  // AND THE ONE THAT IS NOT ABOUT THE WORKSPACE AT ALL. Every section above is scoped by
  // `workspace_id`; this one is scoped by `user_id` and follows somebody to every workspace they
  // are in. It is last because it is the least often wanted, and separate because filing a personal
  // preference under a tenants settings is the conflation §1 of the onboarding spec warns about.
  { id: "account", label: "Account" },
];

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
            <span className={`text-[11px] ${isExpired(link.expiresAt) ? "text-err" : "text-faint"}`}>expires {fmtUntil(link.expiresAt)}</span>
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
    // NO PER-ROW RULE. This was the only list in the app with a divider between every row, and
    // the members list is the one screen entirely about people — whitespace groups them the way
    // every other list here does.
    //
    // AND A REAL INITIAL. The rows drew a generic `UserCircleIcon` — the same anonymous glyph for
    // everybody — on the one screen where several people appear at once. The 20px rounded square
    // is the account row's treatment, which is the canonical one; the card's 16px circle at 9px
    // muted was the third.
    <div className="flex items-center gap-2 rounded-control px-1 py-2 transition-colors hover:bg-active/40">
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control bg-active text-[11px] text-ink"
        aria-hidden
      >
        {(member.display_name || member.email || "?").trim().charAt(0).toUpperCase()}
      </span>
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
        <Select
          value={member.role}
          onChange={(v) => sendSetMemberRole(member.user_id, v)}
          title={ROLES.find((r) => r.id === member.role)?.what}
          ariaLabel={`Role for ${member.display_name || member.email}`}
          align="right"
          className="w-[104px] shrink-0"
          options={ROLES.map((r) => ({ value: r.id, label: r.label, detail: r.what }))}
        />
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
            className="shrink-0 rounded-control px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-active active:bg-chrome hover:text-err"
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
        <span className={`text-[11px] ${isExpired(invite.expires_at) ? "text-err" : "text-faint"}`}>invited · expires {fmtUntil(invite.expires_at)}</span>
      </div>
      <Chip size="sm" tone="faint">{invite.role}</Chip>
      {canManage && (
        <button
          onClick={() => sendRevokeInvite(invite.id)}
          title="Revoke this invitation"
          className="shrink-0 rounded-control px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-active active:bg-chrome hover:text-err"
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
  // Where the upsell card's "See Pro" goes. The panel is already open, so this only moves the
  // section — which is the whole reason Billing is a section of this panel rather than elsewhere.
  const openBilling = useUiStore((s) => s.openWorkspacePanel);
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
            className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 text-[12px] text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
          />
          <Select
            value={role}
            onChange={setRole}
            ariaLabel="Role for the invitation"
            className="w-[104px] shrink-0"
            options={ROLES.map((r) => ({ value: r.id, label: r.label, detail: r.what }))}
          />
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

      {/* WHAT THE TIER REFUSED, above the plain error rather than instead of it. An invite is the
          limit a Free workspace meets first — it is single-user, so the very first invite is
          refused — and "1 of 1 members used, and Pro raises it" beside the form somebody has just
          filled in is a different message from a red sentence, because it names what would change
          it. The card answers only to the `members` channel, so a refused generation puts nothing
          here and a refused invite puts nothing on the composer. */}
      <UpsellCard channel="members" onUpgrade={() => openBilling("billing")} />

      {error && (
        <p className="rounded-control border border-err/30 px-2 py-1.5 text-[11px] text-err">{error}</p>
      )}

      <div>
        <div className="flex items-center px-1 pb-1">
          <span className={TYPE.panelLabel}>Members</span>
          <span className="ml-auto text-[11px] text-faint">{members.length}</span>
        </div>
        {!loaded ? (
          <LoadingLine />
        ) : members.length === 0 ? (
          <EmptyState
            size="inline"
            icon={UserCircleIcon}
            title="Nobody here yet"
            hint={canManage ? "Invite somebody above." : undefined}
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

/**
 * What has been done to this workspace, and by whom.
 *
 * WHY THE ROWS ARE RENDERED ALMOST RAW. An audit trail is read during an incident, by somebody
 * answering a question like "who overrode the secret scan on Tuesday" — and a prettified view that
 * summarised `metadata` would be a view that dropped the field the question turned on. So the action
 * is the headline, the actor and the target are named, and the metadata is printed as it is stored.
 *
 * WHAT IS NOT HERE: paging, filtering, and a date picker. The reader answers the last N rows and this
 * asks for a bounded window of them; the honest thing at this size is to say so rather than to build
 * a search over a table whose rows a person can read in one screen. When it needs more it needs the
 * same offset the rest of the product's lists needed.
 */
function AuditSection() {
  const entries = useAuditStore((s) => s.entries);
  const loaded = useAuditStore((s) => s.loaded);
  const error = useAuditStore((s) => s.error);
  const members = useMemberStore((s) => s.members);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const role = useSessionStore((s) => s.role());
  const canRead = role === "owner";

  // Asked for on open. Nothing pushes an audit row — the log is append-only and there is no
  // broadcast for it — so this is a read whose signal is somebody looking.
  useEffect(() => {
    if (canRead) sendListAudit();
  }, [canRead, workspaceId]);

  // WHO, in the words the members list uses. An actor is a uuid on the row; a workspace holding
  // three people has three names, and rendering the uuid instead would make every question start
  // with a second lookup. It degrades to nothing rather than to a raw id — the same choice
  // `useAuthorLabel` makes on a thread row.
  const nameFor = (userId: string | null): string | null => {
    if (!userId) return null;
    const member = members.find((m) => m.user_id === userId);
    return member ? member.display_name || member.email : null;
  };

  if (!canRead) {
    return (
      <p className="text-[12px] leading-[1.55] text-muted">
        The audit trail is an owner&rsquo;s. Its rows name who revealed which credential, who
        overrode a push refusal and who removed whom.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center pb-1">
        <span className={TYPE.panelLabel}>Newest first</span>
        <span className="ml-auto text-[11px] text-faint">{entries.length}</span>
      </div>
      {error && <p className="mb-2 text-[11px] text-err">{error}</p>}
      {!loaded ? (
        <LoadingLine />
      ) : entries.length === 0 ? (
        <EmptyState
          size="inline"
          icon={ActivityIcon}
          title="Nothing recorded yet"
          hint="Membership changes, credential reveals, push overrides, exports and deletions land here."
        />
      ) : (
        entries.map((e) => {
          const who = nameFor(e.actor_user_id);
          const detail = Object.keys(e.metadata ?? {}).length > 0 ? JSON.stringify(e.metadata) : null;
          return (
            <div key={e.id} className="border-b border-hair py-1.5 last:border-b-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-ink">{e.action}</span>
                {who && <span className="text-[11px] text-muted">{who}</span>}
                {/* An action with no actor is the SERVER acting on its own behalf — a sweeper, a
                    reconciliation, a webhook. Named as such rather than left blank, because "nobody
                    did this" and "we do not know who did this" are different answers. */}
                {!who && !e.actor_user_id && <span className="text-[11px] text-faint">the server</span>}
                <span className="ml-auto shrink-0 text-[11px] text-faint" title={absTime(e.created_at)}>{relTime(e.created_at)}</span>
              </div>
              {(e.target_type || detail || e.ip) && (
                <div className="mt-0.5 break-words font-mono text-[10px] leading-[1.5] text-faint">
                  {e.target_type && <span>{e.target_type}{e.target_id ? ` ${e.target_id}` : ""}</span>}
                  {detail && <span>{e.target_type ? " · " : ""}{detail}</span>}
                  {e.ip && <span> · {e.ip}</span>}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Asking for everything you have, and asking for it to be destroyed.
 *
 * BOTH IN ONE SECTION, and that pairing is the point: the two questions a person asks about their
 * own data are "can I take it with me" and "can I get rid of it", and an interface that offers the
 * second without the first is one where leaving costs you your history. The export is offered
 * first, and the delete says in as many words that the export is the thing to do beforehand.
 *
 * THE EXPORT IS POLLED because there is nothing to push: the archive is written by a worker at a key
 * derived from the export id, and whether it exists is a HEAD on that key. See lib/workspaceApi.ts.
 */
function DataSection() {
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  // `workspace:manage`, which is the owner's. Disabled with a stated reason rather than hidden —
  // the same discipline the composer's model rows follow: a control that vanishes reads as one the
  // product does not have.
  const canManage = workspace?.role === "owner";

  const [exportState, setExportState] = useState<ExportStatus | { status: "starting" } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Polls only while an export is pending, and stops on the first `ready` — an interval that
  // outlived the answer would be a HEAD request every few seconds for the life of the tab.
  useEffect(() => {
    if (!exportState || exportState.status !== "pending") return;
    const id = exportState.exportId;
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const next = await workspaceExportStatus(id);
        if (live) setExportState(next);
      } catch (err) {
        if (live) setExportError((err as Error).message);
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [exportState]);

  const start = async (): Promise<void> => {
    setExportError(null);
    setExportState({ status: "starting" });
    try {
      const started = await startWorkspaceExport();
      setExportState({ exportId: started.exportId, status: "pending" });
    } catch (err) {
      setExportState(null);
      setExportError((err as Error).message);
    }
  };

  const destroy = async (): Promise<void> => {
    if (!workspaceId || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      setReceipt(await deleteWorkspace(workspaceId));
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className={TYPE.sectionLabel}>Export everything</div>
        <p className="mt-1 text-[11px] leading-[1.55] text-muted">
          Every table this workspace owns as NDJSON, plus each agent&rsquo;s current source, in one
          archive. It is written by a worker and can take minutes; the link it produces expires.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className={primaryBtn} onClick={() => void start()} disabled={!canManage || exportState?.status === "pending" || exportState?.status === "starting"}>
            {exportState?.status === "pending" || exportState?.status === "starting" ? "Preparing…" : "Export everything"}
          </button>
          {!canManage && (
            <span className="text-[11px] text-faint">Only an owner can export a workspace</span>
          )}
          {exportState?.status === "pending" && (
            <span className="text-[11px] text-faint">
              Reading every run, step and trace payload. This stays true if you close the panel.
            </span>
          )}
          {exportState?.status === "ready" && (
            <>
              {/* A REAL LINK rather than a scripted download: the URL is presigned and the browser
                  is the thing that should fetch it. `rel=noreferrer` so the signature does not ride
                  a Referer header to wherever the object store logs. */}
              <a
                href={exportState.url}
                rel="noreferrer"
                className={secondaryBtn}
                onClick={() => setExportError(null)}
              >
                Download {(exportState.bytes / 1_000_000).toFixed(1)} MB
              </a>
              <span className={`text-[11px] ${isExpired(exportState.expiresAt) ? "text-err" : "text-faint"}`}>link expires {fmtUntil(exportState.expiresAt)}</span>
            </>
          )}
        </div>
        {exportError && (
          <p className="mt-1.5 text-[11px] text-err">{exportError}</p>
        )}
      </div>

      <div className="border-t border-hair pt-4">
        <div className={TYPE.sectionLabel}>Delete this workspace</div>
        {receipt ? (
          // THE RECEIPT IS THE ANSWER, not a redirect. Somebody asked for their data to be
          // destroyed and is entitled to the count of what was — including whatever could not be
          // revoked at a third party, which is the half a silent success would hide.
          <div className="mt-2 rounded-control border border-edge bg-void px-2.5 py-2">
            <p className="text-[12px] text-ink">This workspace is gone. What was destroyed:</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </div>
        ) : (
          <>
            <p className="mt-1 text-[11px] leading-[1.55] text-muted">
              Rows, objects, checkpoints, queued work, and the grants at the third parties this
              workspace connected. It cannot be undone — export first if you want any of it.
            </p>
            {/* THE TYPED CONFIRMATION IS THE SERVER'S REQUIREMENT, not decoration this screen
                invented: the route refuses a body whose `confirm` is not the workspace's own id. The
                id is rendered beside the box because asking somebody to type an identifier you have
                not shown them is a puzzle rather than a confirmation. */}
            <p className="mt-2 break-all font-mono text-[11px] text-faint select-all">{workspaceId}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={!canManage}
                placeholder="type the id above to confirm"
                className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 font-mono text-[11px] text-ink placeholder:font-sans placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge disabled:opacity-40"
              />
              <button
                onClick={() => void destroy()}
                disabled={!canManage || deleting || confirm.trim() !== workspaceId}
                className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-[12px] text-err transition-colors hover:bg-err/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
            {!canManage && (
              <p className="mt-1.5 text-[11px] text-faint">Only an owner can delete a workspace</p>
            )}
            {deleteError && <p className="mt-1.5 text-[11px] text-err">{deleteError}</p>}
          </>
        )}
      </div>
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
      className="fixed inset-0 z-40 flex items-start justify-center bg-void/80 p-8"
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
            title="Close (Esc)"
            className="ml-auto rounded-control px-1.5 py-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            <XIcon size={ICON.sm} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          {section === "data" ? <DataSection />
            : section === "audit" ? <AuditSection />
            : section === "billing" ? <BillingSection />
            : section === "account" ? <AccountSection />
            : <MembersSection />}
        </div>
      </div>
    </div>
  );
}

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
  sendInviteMember, sendLeaveWorkspace, sendListAudit, sendListMembers, sendRemoveMember,
  sendRevokeInvite, sendSetMemberRole,
} from "../lib/socket.ts";
import { inviteUrl } from "../lib/invite.ts";
import {
  deleteWorkspace, renameWorkspace, startWorkspaceExport, workspaceExportStatus,
  type DeletionReceipt, type ExportStatus,
} from "../lib/workspaceApi.ts";
import { useAuditStore } from "../store/auditStore.ts";
import { useMemberStore, type Invite, type Member } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useCanRun, useCapability } from "../lib/useCapability.ts";
import { useUiStore, type RightTab, type WorkspaceSection } from "../store/uiStore.ts";
import { AccountSection } from "./AccountSection.tsx";
import { absTime, fmtUntil, isExpired, relTime } from "../lib/format.ts";
import { avatarColor, avatarLetter, orderMembers } from "../lib/memberList.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  ActivityIcon, AlertTriangleIcon, CheckIcon, DollarSignIcon, GithubIcon, KeyIcon, PlugIcon,
  TicketIcon, UserCircleIcon, UserPlusIcon, XIcon,
} from "./panelIcons.tsx";
import { Select } from "./Select.tsx";
import { BillingSection } from "./BillingSection.tsx";
import { UpsellCard } from "./UpsellCard.tsx";

const SECTIONS: { id: WorkspaceSection; label: string }[] = [
  // §10.2's first section, and the first one the panel opens on. What the workspace IS — its name,
  // its kind, when it was made — before anything about who is in it or what it costs.
  { id: "general", label: "General" },
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

/**
 * §10.2's General section, and §10's rule about where everything else lives.
 *
 * WHAT THE SECTION ITSELF HOLDS is the three facts §10.2 names: the name, which an owner or an
 * admin may change; the kind, which nobody may change; and the date it was made.
 *
 * WHAT IT ALSO HOLDS IS A LIST OF DOORS, and that is §10's actual requirement rather than a
 * convenience: "At 25-30 teams this does not need to be a unified settings page. But every setting
 * surface must be findable within 2 clicks from the switcher." Four of §10.2's nine sections —
 * Usage, Secrets, Connections, Integrations — are right-panel tabs, and a right-panel tab is not
 * reachable from the switcher at all. Copying them into this modal would be the unified settings
 * page §16 puts out of scope, and would give each of them two homes that could disagree. A row
 * that opens the tab it names is one click from here and two from the switcher, which is what was
 * asked for.
 */
function GeneralSection() {
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const setWorkspaces = useSessionStore((s) => s.setWorkspaces);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const closePanel = useUiStore((s) => s.closeWorkspacePanel);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [name, setName] = useState(workspace?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * §10.2 — "Workspace name (editable for owner/admin)".
   *
   * OWNER OR ADMIN, WHICH IS THE ROUTE'S OWN RULE AND NOT `workspace:manage`. `/v1/workspaces/
   * rename` checks the role directly — `session.role !== "owner" && session.role !== "admin"` —
   * rather than going through the capability matrix, because it is an HTTP route that runs before
   * a socket exists during onboarding. So the guard here reads the same two roles the route reads,
   * and `ROUTE_CAPABILITY.workspaceRename` is deliberately not what decides: it names
   * `workspace:manage`, the owner's, and using it would hide the field from the admins the route
   * would have accepted.
   */
  const role = useSessionStore((s) => s.role());
  const canRename = role === "owner" || role === "admin";

  // Re-seeded when the workspace changes. Without this, switching with the panel open would leave
  // the previous workspace's name in the field — over a Save button that would rename this one.
  useEffect(() => {
    setName(workspace?.name ?? "");
    setError(null);
    setSaved(false);
  }, [workspaceId, workspace?.name]);

  const save = async (): Promise<void> => {
    const wanted = name.trim();
    if (busy || !wanted || !workspaceId || wanted === workspace?.name) return;
    setBusy(true);
    setError(null);
    try {
      const renamed = await renameWorkspace(workspaceId, wanted);
      // The session's copy, updated in place. The rename is broadcast to other sockets in the
      // workspace; this tab's own session is not refetched until the next connect, so without this
      // the switcher above would keep the old name until a reconnect.
      setWorkspaces(workspaces.map((w) => (w.id === workspaceId ? { ...w, name: renamed.name } : w)));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!workspace) return null;
  const dirty = name.trim() !== workspace.name && name.trim().length > 0;

  return (
    <div className="space-y-5">
      <div>
        <div className={TYPE.sectionLabel}>Name</div>
        {canRename ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              value={name}
              maxLength={64}
              onChange={(e) => { setName(e.target.value); setSaved(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              aria-label="Workspace name"
              className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink outline-none focus-visible:shadow-focusring focus:border-edge"
            />
            <button className={secondaryBtn} onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </button>
            {saved && !dirty && <span className="text-tiny text-ok">Saved</span>}
          </div>
        ) : (
          // Absent rather than disabled — §8. A member reads the name they already see at the top
          // of the sidebar; what is gone is the box that would refuse to save.
          <p className="mt-1.5 text-caption text-ink">{workspace.name}</p>
        )}
        {error && <p className="mt-1.5 text-tiny text-err">{error}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className={TYPE.sectionLabel}>Kind</div>
          {/* READ-ONLY AND SAID SO — §10.2 marks it that way and §1.3 froze it: `kind` decides
              whether the workspace has a members list, roles and a Threads author column at all,
              and it cannot change after creation. A control that looked editable would be offering
              the one field the product genuinely cannot move. */}
          <p className="mt-1.5 text-caption text-ink">{workspace.kind}</p>
          <p className="mt-0.5 text-tiny leading-[1.5] text-faint">
            {workspace.kind === "team"
              ? "Members, roles and invitations. Threads show who did what."
              : "Just you. No members list and no author column."}
            {" "}Chosen at creation and fixed.
          </p>
        </div>
        <div>
          <div className={TYPE.sectionLabel}>Created</div>
          {/* A server that predates §13.1's `createdAt` sends nothing. A dash rather than an
              invented date, which is the same rule §3.5 of the Activity spec sets for an unknown
              figure: `--`, never a zero that looks like an answer. */}
          <p className="mt-1.5 text-caption text-ink" title={workspace.createdAt ? absTime(workspace.createdAt) : undefined}>
            {workspace.createdAt ? absTime(workspace.createdAt) : "—"}
          </p>
          <p className="mt-0.5 break-all text-tiny text-faint select-all">{workspace.id}</p>
        </div>
      </div>

      <div className="border-t border-hair pt-3">
        <div className={TYPE.sectionLabel}>Everything else about this workspace</div>
        <p className="mt-1 text-tiny leading-[1.55] text-muted">
          These live in the right panel, where the surfaces they belong to already are. Opening one
          closes this.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-1">
          {WORKSPACE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setRightTab(t.id); closePanel(); }}
              className="flex items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-active active:bg-chrome"
            >
              <span className="mt-0.5 shrink-0 text-faint" aria-hidden><t.Icon size={ICON.xs} /></span>
              <span className="min-w-0">
                <span className="block text-caption text-ink">{t.label}</span>
                <span className="block text-tiny leading-[1.5] text-faint">{t.what}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * §10.2's four sections that are right-panel tabs, and what each one is for.
 *
 * THE DESCRIPTIONS ARE THE POINT rather than decoration. "Connections" and "Secrets" are two words
 * that sound like the same thing to somebody who has not used the product — one is an account this
 * workspace has been granted access to, the other is a value stored in its vault — and a settings
 * index whose rows are single nouns is an index somebody has to click through to read.
 */
const WORKSPACE_TABS: {
  id: RightTab;
  label: string;
  what: string;
  Icon: (p: { size?: number }) => React.ReactElement;
}[] = [
  { id: "usage", label: "Usage", what: "What this workspace has spent, and against which ceiling", Icon: DollarSignIcon },
  { id: "secrets", label: "Secrets", what: "Credentials, their health, and when each was last rotated", Icon: KeyIcon },
  { id: "connections", label: "Connections", what: "Accounts this workspace's agents may act on behalf of", Icon: PlugIcon },
  { id: "github", label: "Integrations", what: "Where each agent's code goes, its checks and its scan findings", Icon: GithubIcon },
];

/**
 * §7.1's copyable link, which exists exactly once and takes itself away.
 *
 * THIRTY SECONDS, WHICH IS THE SPEC'S FIGURE AND ITS REASON: "the copyable field disappears after
 * 30 seconds or on dismiss — the token is one-shot and should not linger". A live credential
 * sitting on a panel somebody has walked away from is the failure it is protecting against, and it
 * is a real one here: this box appears in a shared office on a screen its owner has stopped
 * looking at, and the token in it is a membership in their workspace.
 *
 * IT IS NOT A SECURITY BOUNDARY and is not claimed as one — anybody who has the screen has had
 * thirty seconds too. What it is is the difference between a link that is on screen while it is
 * being copied and one that is on screen for the rest of the afternoon.
 */
const INVITE_LINK_SECONDS = 30;

function InviteLink() {
  const link = useMemberStore((s) => s.inviteLink);
  const dismiss = useMemberStore((s) => s.dismissInviteLink);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(INVITE_LINK_SECONDS);

  // A ticking count rather than one silent timeout, because a box that vanishes without warning
  // while somebody is reaching for it reads as the app losing their invitation — which, since the
  // token is one-shot and only a digest is stored, is exactly what has happened.
  useEffect(() => {
    if (!link) return;
    setLeft(INVITE_LINK_SECONDS);
    setCopied(false);
    const started = Date.now();
    const tick = setInterval(() => {
      const remaining = INVITE_LINK_SECONDS - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) {
        clearInterval(tick);
        dismiss();
        return;
      }
      setLeft(remaining);
    }, 1000);
    return () => clearInterval(tick);
    // Keyed on the TOKEN, not on the object: a re-render that produced an equal object would
    // otherwise restart the countdown, and a countdown that restarts never finishes.
  }, [link?.token, dismiss]);

  if (!link) return null;
  const url = inviteUrl(window.location.origin, link.token);

  return (
    <div className="mt-2 rounded-control border border-run/40 bg-run/5 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-run"><AlertTriangleIcon size={ICON.xs} /></span>
        <div className="min-w-0 flex-1">
          {/* TWO SENTENCES, BECAUSE THEY ARE TWO DIFFERENT CREDENTIALS. An addressed invitation is
              only redeemable by an account signing in as that address, so a leak is inert; a link
              invitation is redeemable by whoever holds it, and saying so here is the one moment
              somebody can still decide they wanted the other kind. */}
          <p className="text-caption leading-[1.55] text-ink">
            {link.email
              ? `Send this to ${link.email}. Only an account signing in as that address can use it.`
              : "Anyone with this link can join this workspace. Send it only to people you mean to invite."}{" "}
            It is shown once — only a hash of it is stored here, so dismissing this loses it and the
            invitation has to be reissued.
          </p>
          {/* SELECTABLE AND WRAPPED rather than truncated. It is a credential somebody has to get
              out of this box by hand, and a middle-elided link cannot be read back if the copy
              button is the thing that failed. */}
          <p className="mt-1.5 break-all rounded-chip bg-void px-2 py-1.5 text-tiny text-muted select-all">
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
            <span className={`text-tiny ${isExpired(link.expiresAt) ? "text-err" : "text-faint"}`}>expires {fmtUntil(link.expiresAt)}</span>
            {/* THE COUNTDOWN IS ON THE DISMISS BUTTON rather than beside the expiry, because the
                two numbers mean opposite things and would otherwise sit together looking alike:
                the invitation is good for a week, and this BOX is good for thirty seconds. */}
            <button className={`${quietBtn} ml-auto tabular-nums`} onClick={dismiss}>
              Dismiss ({left}s)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * §6.3's ownership transfer — the one action on this screen that cannot be taken back.
 *
 * TYPING THE WORKSPACE NAME, which is the pattern §6.3 names by reference: "confirm with the
 * workspace name typed out (same pattern as workspace delete)". The two acts are alike in the way
 * that matters — after either one, the person who did it cannot undo it — and unlike a removal,
 * which §6.4 gives a single button precisely because re-inviting exists.
 *
 * IT IS TWO COMMANDS, NOT ONE, AND THAT IS VISIBLE HERE RATHER THAN HIDDEN IN THE SERVER. §6.3
 * says a transfer demotes the current owner to Admin; the repository's `setMemberRole` changes one
 * membership and says nothing about a second, and §16 is explicit about not growing server-side
 * business logic beyond §13's list. So the promotion goes first and the demotion second, in that
 * order and not the other: promoting first means the workspace has two owners for the moment in
 * between, and demoting first would mean it has none — which `setMemberRole`'s last-owner guard
 * would refuse anyway, turning the whole transfer into a no-op with an error on it.
 *
 * IF THE SECOND COMMAND IS LOST the workspace has two owners, which is a state the product already
 * supports, is visible in the list directly beneath this, and either of them can finish. That is
 * the honest failure for a two-step change on a socket: recoverable and legible, rather than
 * atomic and invented.
 */
function TransferConfirm({ member, onDone }: { member: Member; onDone: () => void }) {
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const selfId = useSessionStore((s) => s.user?.id ?? null);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [typed, setTyped] = useState("");
  const name = workspace?.name ?? "";
  const who = member.display_name || member.email;

  const transfer = (): void => {
    sendSetMemberRole(member.user_id, "owner");
    // The demotion names the person doing it, read from the session rather than passed in, because
    // this control is only ever rendered on a row an owner is looking at.
    if (selfId) sendSetMemberRole(selfId, "admin");
    onDone();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Transfer ownership of ${name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 px-4"
    >
      <div className="w-full max-w-md rounded-modal border border-edge bg-panel p-4 shadow-overlay">
        <div className={TYPE.sectionLabel}>Transfer ownership</div>
        {/* §6.3's sentence, close to verbatim, because both halves of it are the point: who is
            getting it, and what happens to you. An owner who reads only the first half is an owner
            who has not been told they are about to stop being one. */}
        <p className="mt-2 text-caption leading-[1.55] text-ink">
          Transfer ownership of <span className="text-ink">{name}</span> to{" "}
          <span className="text-ink">{who}</span>? You will become an Admin.
        </p>
        <p className="mt-1.5 text-tiny leading-[1.55] text-muted">
          An Admin cannot change membership, billing, or delete the workspace. Only {who} will be
          able to give it back.
        </p>
        <p className="mt-2.5 break-all text-tiny text-faint select-all">{name}</p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="type the workspace name above to confirm"
          aria-label="Workspace name"
          className="mt-1.5 w-full rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={transfer}
            // TRIMMED ON THE TYPED SIDE ONLY. A workspace name with a trailing space is a name
            // somebody cannot type twice the same way, and this is a confirmation rather than a
            // checksum — the gesture is what is being asked for.
            disabled={typed.trim() !== name.trim() || name.trim() === ""}
            className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-caption text-err transition-colors hover:bg-err/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Transfer ownership
          </button>
          <button onClick={onDone} className={quietBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A confirmation with one button and nothing to type.
 *
 * §6.4 IS EXPLICIT ABOUT THE ASYMMETRY WITH THE TRANSFER ABOVE, and gives the reason in a clause:
 * "single confirm button, no typing required (removing is reversible via re-invite, unlike
 * delete)". A typed confirmation is a friction that should be spent only where the act cannot be
 * undone — spend it on everything and it stops being read, which is how somebody ends up typing a
 * workspace name to confirm the thing they meant to do and then typing it again for the thing they
 * did not.
 *
 * The same shape serves §6.5's departure, which is the same act performed on yourself: one
 * sentence naming what is lost, one button.
 */
function ConfirmDialog({
  title,
  body,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 px-4"
    >
      <div className="w-full max-w-md rounded-modal border border-edge bg-panel p-4 shadow-overlay">
        <div className={TYPE.sectionLabel}>{title}</div>
        <p className="mt-2 text-caption leading-[1.55] text-ink">{body}</p>
        {detail && <p className="mt-1.5 text-tiny leading-[1.55] text-muted">{detail}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button
            autoFocus
            onClick={onConfirm}
            className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-caption text-err transition-colors hover:bg-err/20"
          >
            {confirmLabel}
          </button>
          <button onClick={onCancel} className={quietBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** §6.4's removal. The sentence is the spec's, because both halves of it are what is being asked. */
function RemoveConfirm({ member, onDone }: { member: Member; onDone: () => void }) {
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const name = workspaces.find((w) => w.id === workspaceId)?.name ?? "this workspace";
  const who = member.display_name || member.email;

  return (
    <ConfirmDialog
      title="Remove member"
      body={`Remove ${who} from ${name}? They will lose access to all agents and threads.`}
      // §6.4's other half, which the spec states as behaviour rather than as copy: the server
      // closes their open socket. Somebody about to do this should know it takes effect on a
      // colleague who may be mid-run rather than at their next sign-in.
      detail="Their open session ends immediately. You can invite them back at any time."
      confirmLabel="Remove"
      onConfirm={() => {
        sendRemoveMember(member.user_id);
        onDone();
      }}
      onCancel={onDone}
    />
  );
}

function MemberRow({ member, canManage, isSelf }: { member: Member; canManage: boolean; isSelf: boolean }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  /**
   * §6.3's ownership transfer, held here until the workspace name has been typed.
   *
   * IT IS THE MOST DANGEROUS ACTION ON THIS SCREEN and it does not look like one: it is a
   * selection in a dropdown, one row below two selections that are ordinary. Promoting somebody to
   * Admin is reversible by the person who did it; promoting somebody to Owner is reversible only
   * by the person it was done TO, because the act of doing it is the act of giving away the
   * authority to undo it.
   */
  const [transferTo, setTransferTo] = useState<string | null>(null);

  /**
   * §6.3 — "the owner cannot demote themselves", so their own row has a badge rather than a
   * dropdown.
   *
   * THE SERVER REFUSES THIS TOO, and differently: `setMemberRole` refuses the LAST owner, which
   * lets an owner step back once a second owner exists. That is the right rule for the repository
   * — it is about the workspace staying administrable — and it is not the rule this control wants.
   * From here the only way to stop being the owner is §6.3's transfer, which names the person
   * taking over in the same gesture; a bare "make me an Admin" would be an owner leaving the
   * workspace without an owner in every case except the one where somebody else already is one.
   */
  const roleIsFixed = isSelf && member.role === "owner";

  const changeRole = (next: string): void => {
    if (next === member.role) return;
    // Promotion to owner is not sent from here. It goes through the confirmation below, which is
    // the only path that also demotes the person doing it — see `TransferConfirm`.
    if (next === "owner") {
      setTransferTo(next);
      return;
    }
    sendSetMemberRole(member.user_id, next);
  };

  return (
    // NO PER-ROW RULE. This was the only list in the app with a divider between every row, and
    // the members list is the one screen entirely about people — whitespace groups them the way
    // every other list here does.
    //
    // AND A REAL INITIAL. The rows drew a generic `UserCircleIcon` — the same anonymous glyph for
    // everybody — on the one screen where several people appear at once. The 20px rounded square
    // is the account row's treatment, which is the canonical one; the card's 16px circle at 9px
    // muted was the third.
    <div
      // §6.2 — "the current user's own row has a SUBTLE highlight". A background at the same
      // weight the list uses for hover, permanently: enough to find yourself in a column of six,
      // not enough to read as a selection.
      className={`flex items-center gap-2 rounded-control px-1 py-2 transition-colors ${
        isSelf ? "bg-active/30" : "hover:bg-active/40"
      }`}
    >
      {/* §6.2's stable colour, from the user id through the same FNV-1a the agent gradients use.
          It is a mnemonic rather than a status: the letter and the name are what identify
          somebody, and this is what makes a row findable again once you have seen it. See
          lib/memberList.ts for why the palette is deliberately off-token. */}
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-tiny text-void"
        style={{ background: avatarColor(member.user_id) }}
        aria-hidden
      >
        {avatarLetter(member)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Truncate className="text-caption text-ink" title={member.email}>
            {member.display_name || member.email}
          </Truncate>
          {isSelf && <Chip size="sm" tone="faint" variant="bare">you</Chip>}
        </div>
        {/* §6.2 asks for the email AND a "Joined" date on every row. The address only when there
            is a name above it — otherwise the row would print it twice — and the date always,
            because "who has been here longest" is the question a members list is read for after
            "who is here". */}
        <div className="flex min-w-0 items-baseline gap-2">
          {member.display_name && (
            <Truncate className="min-w-0 text-tiny text-faint" title={member.email}>{member.email}</Truncate>
          )}
          <span className="shrink-0 text-tiny text-faint" title={absTime(member.created_at)}>
            joined {relTime(member.created_at)}
          </span>
        </div>
      </div>

      {/* THE ROLE IS THE CONTROL, not a label with a control beside it. A select that shows the
          current role is one element saying what is true and offering the change; a label plus an
          "Edit" button is two, and the second one only ever opens the first. */}
      {canManage && !roleIsFixed ? (
        <Select
          value={member.role}
          onChange={changeRole}
          title={ROLES.find((r) => r.id === member.role)?.what}
          ariaLabel={`Role for ${member.display_name || member.email}`}
          align="right"
          className="w-[104px] shrink-0"
          options={ROLES.map((r) => ({ value: r.id, label: r.label, detail: r.what }))}
        />
      ) : (
        <Chip size="sm" tone="faint">{member.role}</Chip>
      )}
      {transferTo && (
        <TransferConfirm member={member} onDone={() => setTransferTo(null)} />
      )}

      {/* §6.4 — ON EVERY ROW EXCEPT THE OWNER'S. An owner is removed by being transferred out of
          ownership first, which is what `TransferConfirm` above is; a remove button on their row
          would be a button whose only outcome is the server's last-owner refusal. */}
      {canManage && member.role !== "owner" && (
        <button
          onClick={() => setConfirmRemove(true)}
          title={`Remove ${member.email}`}
          aria-label={`Remove ${member.display_name || member.email}`}
          className="shrink-0 rounded-control px-1.5 py-1 text-tiny text-faint transition-colors hover:bg-active active:bg-chrome hover:text-err"
        >
          <XIcon size={ICON.xs} />
        </button>
      )}
      {confirmRemove && (
        <RemoveConfirm
          member={member}
          onDone={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

function InviteRow({ invite, canManage }: { invite: Invite; canManage: boolean }) {
  // §7.2 — "invited email (or 'Anyone with the link' if no email was specified)". The phrase is
  // the spec's and is a warning rather than a placeholder: this row is the only place an admin
  // finds out that a live credential is loose in a Slack channel somewhere.
  const anyone = invite.email === null;
  return (
    <div className="flex items-center gap-2 border-b border-hair px-1 py-2 last:border-b-0">
      <span className="shrink-0 text-faint">
        {anyone ? <TicketIcon size={ICON.sm} /> : <UserCircleIcon size={ICON.sm} />}
      </span>
      <div className="min-w-0 flex-1">
        <Truncate className={`text-caption ${anyone ? "text-faint" : "text-muted"}`} title={invite.email ?? undefined}>
          {invite.email ?? "Anyone with the link"}
        </Truncate>
        {/* §7.2 asks for the CREATED date. The expiry is kept beside it because it is the half
            that decides whether the row is still worth anything — a link created three days ago
            with an hour left is a different thing to chase than one created an hour ago. */}
        <span className={`text-tiny ${isExpired(invite.expires_at) ? "text-err" : "text-faint"}`}>
          <span title={absTime(invite.created_at)}>invited {relTime(invite.created_at)}</span>
          {" · "}expires {fmtUntil(invite.expires_at)}
        </span>
      </div>
      <Chip size="sm" tone="faint">{invite.role}</Chip>
      {/* §7.2 — NO CONFIRMATION, and the spec gives the reason: "revoking an invite is harmless
          (they just can't use the link anymore)". A dialog in front of it would be friction spent
          on the one action here that costs nothing to get wrong, which is how the friction in
          front of the two that DO cost something stops being read. */}
      {canManage && (
        <button
          onClick={() => sendRevokeInvite(invite.id)}
          title="Revoke this invitation"
          aria-label={`Revoke the invitation for ${invite.email ?? "anyone with the link"}`}
          className="shrink-0 rounded-control px-1.5 py-1 text-tiny text-faint transition-colors hover:bg-active active:bg-chrome hover:text-err"
        >
          <XIcon size={ICON.xs} />
        </button>
      )}
    </div>
  );
}

/**
 * §6.5's departure, at the foot of the members panel.
 *
 * ABSENT FOR THE OWNER, not disabled — §6.5 says so and §1.3's frozen rule says why. The server
 * refuses an owner outright, so a disabled button would be an offer whose only outcome is a
 * refusal; what an owner does instead is transfer, which the list above already offers.
 *
 * IT IS NOT A REMOVAL PERFORMED ON YOURSELF. `removeMember` needs `member:manage`, which is the
 * owner's — so a member trying to leave through that command gets a 403, and the whole reason
 * `leaveWorkspace` exists is that it needs no authority over anybody else. See capabilities.ts.
 */
function LeaveWorkspace() {
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const role = useSessionStore((s) => s.role());
  const [confirming, setConfirming] = useState(false);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace || role === "owner") return null;

  return (
    <div className="border-t border-hair pt-3">
      <button
        onClick={() => setConfirming(true)}
        className="rounded-control px-2 py-1 text-caption text-muted transition-colors hover:bg-active active:bg-chrome hover:text-err"
      >
        Leave {workspace.name}
      </button>
      {confirming && (
        <ConfirmDialog
          title="Leave workspace"
          body={`Leave ${workspace.name}? You'll need a new invite to rejoin.`}
          detail="Your agents, threads and runs stay where they are — they belong to the workspace, not to you."
          confirmLabel="Leave"
          onConfirm={() => {
            sendLeaveWorkspace();
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
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
  // NAMES THE COMMAND, WHICH IS THE POINT OF THE MATRIX. This read `workspace?.role === "owner"`
  // while its own comment said "see the capability matrix, which is the only thing that decides" —
  // a guard that names a rule in prose and then does not consult it. `inviteMember` is what the
  // form below sends, and `member:manage` is what it needs; neither of those is spelled here on
  // purpose. Offered from the role this tab holds and refused again by the server: hiding what
  // somebody may not do is honesty about what the next click achieves, never the enforcement.
  const canManage = useCanRun("inviteMember");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [inviting, setInviting] = useState(false);

  // Asked for on open, not held. The relay pushes the list in its initial snapshot for a team
  // workspace and re-broadcasts on every mutation, so this is the one case it cannot cover: a
  // personal workspace, where the snapshot deliberately sends nothing.
  useEffect(() => {
    sendListMembers();
  }, [workspaceId]);

  const invite = (e: React.FormEvent): void => {
    e.preventDefault();
    // §7.1 — THE ADDRESS IS OPTIONAL AND AN EMPTY ONE IS NOT A MISTAKE. This used to return early
    // on a blank field, which made the form's only outcome an addressed invitation and left the
    // link-for-anybody case unreachable from the product entirely. Blank now means exactly what it
    // looks like: a link, for whoever the admin sends it to.
    sendInviteMember(email.trim() || null, role);
    setEmail("");
    setInviting(false);
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
          <span className="text-tiny text-faint">
            Threads show no author column in a personal workspace
          </span>
        )}
      </div>

      {/* §7.1 — THE FORM IS BEHIND A BUTTON RATHER THAN PERMANENTLY OPEN. A members panel is read
          far more often than it is written to; a form standing open at the top of it is a control
          asking to be noticed for something nobody is doing, which is the same argument the
          sidebar's search field settled the same way. */}
      {canManage && !inviting && (
        <button onClick={() => setInviting(true)} className={secondaryBtn}>
          <UserPlusIcon size={ICON.xs} /> Invite
        </button>
      )}
      {canManage && inviting && (
        <div>
          {/* INLINE, NOT A MODAL — §7.1 says so, and the reason is the list underneath: the thing
              an inviter checks before inviting is whether that person is already here. */}
          <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="colleague@example.com — or leave blank for a link"
              aria-label="Email address for the invitation, optional"
              className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
            />
            <Select
              value={role}
              onChange={setRole}
              ariaLabel="Role for the invitation"
              className="w-[104px] shrink-0"
              // §7.1 — "Admin or Member; Owner is not invitable". A workspace gets its owner by
              // being created and changes it by §6.3's transfer, both of which name a person who
              // is already here; an invitation that handed ownership to an address would give the
              // workspace away to whoever opened an email.
              options={ROLES.filter((r) => r.id !== "owner").map((r) => ({
                value: r.id,
                label: r.label,
                detail: r.what,
              }))}
            />
            <button type="submit" className={primaryBtn}>Invite</button>
            <button type="button" onClick={() => setInviting(false)} className={quietBtn}>Cancel</button>
          </form>
          <p className="mt-1.5 text-tiny leading-[1.55] text-faint">
            {ROLES.find((r) => r.id === role)?.what}. There is no mail sender here — you get a link
            to send, once.{" "}
            {email.trim()
              ? "Only an account signing in as that address will be able to use it."
              : "With no address, anyone you send it to can use it."}
          </p>
        </div>
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
        <p className="rounded-control border border-err/30 px-2 py-1.5 text-tiny text-err">{error}</p>
      )}

      <div>
        <div className="flex items-center px-1 pb-1">
          <span className={TYPE.panelLabel}>Members</span>
          <span className="ml-auto text-tiny text-faint">{members.length}</span>
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
          // §6.2's order — owner, admins, members, each group alphabetical — applied here rather
          // than expected of the server. The relay re-broadcasts this list on every mutation and
          // the SQL behind it has no ORDER BY that means anything to a reader, so a list that
          // trusted the arrival order would reshuffle itself every time somebody's role changed.
          orderMembers(members).map((m) => (
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
            {/* §7.2's own words: "Invitations" normally, "Pending invites" when there are any.
                The distinction is worth keeping — the heading is a list of things still waiting on
                somebody, and calling it "Invited" implied they had arrived. */}
            <span className={TYPE.panelLabel}>Pending invites</span>
            <span className="ml-auto text-tiny text-faint">{invites.length}</span>
          </div>
          {invites.map((i) => (
            <InviteRow key={i.id} invite={i} canManage={canManage} />
          ))}
        </div>
      )}

      {/* §6.5, at the bottom, and absent for the owner. Last because it is the row that ends your
          relationship with everything above it. */}
      <LeaveWorkspace />
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
  // `listAudit` — `workspace:manage`, which the matrix answers and this no longer guesses.
  const canRead = useCanRun("listAudit");

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
      <p className="text-caption leading-[1.55] text-muted">
        The audit trail is an owner&rsquo;s. Its rows name who revealed which credential, who
        overrode a push refusal and who removed whom.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center pb-1">
        <span className={TYPE.panelLabel}>Newest first</span>
        <span className="ml-auto text-tiny text-faint">{entries.length}</span>
      </div>
      {error && <p className="mb-2 text-tiny text-err">{error}</p>}
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
                <span className="text-tiny text-ink">{e.action}</span>
                {who && <span className="text-tiny text-muted">{who}</span>}
                {/* An action with no actor is the SERVER acting on its own behalf — a sweeper, a
                    reconciliation, a webhook. Named as such rather than left blank, because "nobody
                    did this" and "we do not know who did this" are different answers. */}
                {!who && !e.actor_user_id && <span className="text-tiny text-faint">the server</span>}
                <span className="ml-auto shrink-0 text-tiny text-faint" title={absTime(e.created_at)}>{relTime(e.created_at)}</span>
              </div>
              {(e.target_type || detail || e.ip) && (
                <div className="mt-0.5 break-words text-tiny leading-[1.5] text-faint">
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
  // `workspace:manage`, asked of the matrix. Export and delete are the same capability, so one
  // boolean rather than one each — see `Capable`'s note on when a `&&` beats a wrapper.
  //
  // THE COMMENT HERE USED TO SAY "disabled with a stated reason rather than hidden", which stopped
  // being true when these two became absent, and a comment describing the opposite of the code is
  // worse than none: it is the version a reader trusts.
  const canManage = useCapability("workspace:manage");

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
        <p className="mt-1 text-tiny leading-[1.55] text-muted">
          Every table this workspace owns as NDJSON, plus each agent&rsquo;s current source, in one
          archive. It is written by a worker and can take minutes; the link it produces expires.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* §8.2 — "Workspace panel / Export workspace / workspace:manage", which is the owner's.
              ABSENT, NOT DISABLED. It was a greyed button with "only an owner can export a
              workspace" beside it, which is the exact shape §8 rules out — and the sentence made
              it worse rather than better: a control that explains why it will not work is a
              control that has decided somebody should keep looking at it. */}
          {canManage && (
            <button className={primaryBtn} onClick={() => void start()} disabled={exportState?.status === "pending" || exportState?.status === "starting"}>
              {exportState?.status === "pending" || exportState?.status === "starting" ? "Preparing…" : "Export everything"}
            </button>
          )}
          {exportState?.status === "pending" && (
            <span className="text-tiny text-faint">
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
              <span className={`text-tiny ${isExpired(exportState.expiresAt) ? "text-err" : "text-faint"}`}>link expires {fmtUntil(exportState.expiresAt)}</span>
            </>
          )}
        </div>
        {exportError && (
          <p className="mt-1.5 text-tiny text-err">{exportError}</p>
        )}
      </div>

      <div className="border-t border-hair pt-4">
        <div className={TYPE.sectionLabel}>Delete this workspace</div>
        {receipt ? (
          // THE RECEIPT IS THE ANSWER, not a redirect. Somebody asked for their data to be
          // destroyed and is entitled to the count of what was — including whatever could not be
          // revoked at a third party, which is the half a silent success would hide.
          <div className="mt-2 rounded-control border border-edge bg-void px-2.5 py-2">
            <p className="text-caption text-ink">This workspace is gone. What was destroyed:</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-tiny text-muted">
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </div>
        ) : (
          <>
            <p className="mt-1 text-tiny leading-[1.55] text-muted">
              Rows, objects, checkpoints, queued work, and the grants at the third parties this
              workspace connected. It cannot be undone — export first if you want any of it.
            </p>
            {/* THE TYPED CONFIRMATION IS THE SERVER'S REQUIREMENT, not decoration this screen
                invented: the route refuses a body whose `confirm` is not the workspace's own id. The
                id is rendered beside the box because asking somebody to type an identifier you have
                not shown them is a puzzle rather than a confirmation. */}
            {/* §8.2 — "Workspace panel / Delete workspace / workspace:manage / OWNER ONLY". The
                one row in the checklist the spec itself narrows to the owner, and the matrix
                agrees. The id above stays visible for everybody because it is the thing support
                asks for; the box that would spend it does not. */}
            {canManage && (
              <>
                <p className="mt-2 break-all text-tiny text-faint select-all">{workspaceId}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="type the id above to confirm"
                    className="min-w-0 flex-1 rounded-control border border-hair bg-void px-2.5 py-1.5 text-tiny text-ink placeholder:font-sans placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
                  />
                  <button
                    onClick={() => void destroy()}
                    disabled={deleting || confirm.trim() !== workspaceId}
                    className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-caption text-err transition-colors hover:bg-err/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {deleting ? "Deleting…" : "Delete permanently"}
                  </button>
                </div>
              </>
            )}
            {deleteError && <p className="mt-1.5 text-tiny text-err">{deleteError}</p>}
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
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const kind = workspaces.find((w) => w.id === workspaceId)?.kind ?? null;

  /**
   * §6.1 and §9.4 — a PERSONAL workspace has no members tab at all.
   *
   * THIS REVERSES A DELIBERATE DECISION AND THE REASON IT REVERSES IS §3. The note that used to sit
   * on the Members entry said it was offered for a personal workspace too, because "hiding the list
   * would make 'invite somebody' undiscoverable in the only workspace most accounts have" — which
   * was correct when the only workspace most accounts had was the one `provisionUser` made, and
   * nothing in the product could make another. §3 changed that: "+ Create workspace" is two clicks
   * from every screen now, so the answer to "how do I invite a colleague" is a team workspace
   * rather than a members list on a workspace whose whole definition is that it is just you.
   *
   * ABSENT, NOT DISABLED — §6.1 says so in the same words §8 uses everywhere else.
   *
   * AUDIT STAYS. §9.4 names three things that must not appear in a personal workspace — the
   * members panel, the Threads author column, role badges — and the audit log is none of them: it
   * records exports, deletions, credential reveals and push overrides, every one of which happens
   * in a personal workspace and every one of which somebody may need to look up afterwards.
   */
  const sections = SECTIONS.filter((s) => s.id !== "members" || kind !== "personal");

  /**
   * The section actually rendered, which is not always the one that was asked for.
   *
   * A CALLER NAMES A SECTION AND THE PANEL DECIDES WHETHER IT EXISTS. Every entry point passes a
   * section — that is the whole reason `workspaceSection` is a store field rather than local state
   * — and one of them, the switcher's settings row, has no way to know whether this workspace has
   * a members list. Resolving here means a personal workspace opens on something real instead of
   * on a tab that is not in the strip above it.
   */
  const shown = sections.some((s) => s.id === section) ? section : sections[0]?.id ?? null;

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
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => open(s.id)}
                className={`rounded-control px-2.5 py-1 text-caption transition-colors ${
                  shown === s.id ? "bg-active text-ink" : "text-muted hover:text-ink"
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
          {shown === "general" ? <GeneralSection />
            : shown === "data" ? <DataSection />
            : shown === "audit" ? <AuditSection />
            : shown === "billing" ? <BillingSection />
            : shown === "account" ? <AccountSection />
            : <MembersSection />}
        </div>
      </div>
    </div>
  );
}

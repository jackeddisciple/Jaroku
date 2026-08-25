// §12 — the people who are about to be able to reach this, and the letters nobody opened.
//
// A VIEW ONTO THE EXISTING INVITE SYSTEM, NOT A REIMPLEMENTATION. The rows are the workspace's own
// `workspace_invites`, revoking sends the `revokeInvite` command v0.4.1 already has, and nothing
// about how an invitation works changes here. What this section adds is placement: a panel that
// answers "who can reach this agent" is incomplete without the people who are one click away from
// being able to, and that list currently lives two panels away in a workspace settings screen
// nobody opens while looking at an agent.
//
// THE SECTION SAYS "WORKSPACE" IN EVERY SENTENCE IT CAN. §12.1 names the failure directly: an admin
// must never think they have granted narrow agent access when they have actually widened the
// tenancy. An invitation is to the WORKSPACE — it carries a workspace role, and that role is a
// ceiling over every agent in it — so this section is careful never to imply that inviting somebody
// from an agent's panel invites them to an agent.
//
// AND IT DOES NOT OFFER TO INVITE. §12.1 asks for a "+ Invite" button with an optional pre-staged
// grant; that half is §12.2's atomic acceptance and is a decision recorded in the changelog rather
// than a control here — see the release notes. The existing Members panel is where an invitation is
// made, and this links to it rather than growing a second door onto the same act.

import { Truncate } from "./Truncate.tsx";
import { Chip } from "./Chip.tsx";
import { quietBtn } from "./buttons.ts";
import { AlertTriangleIcon, TicketIcon } from "./panelIcons.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { sendRevokeInvite } from "../lib/socket.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { PendingInvite } from "../store/accessStore.ts";

export function AccessInvites({
  invites,
  canManage,
}: {
  invites: PendingInvite[];
  /**
   * `member:manage` — the OWNER's, and not the agent-level `admin` every other control here reads.
   *
   * THE ONE PLACE THIS PANEL'S OWN CAPABILITY IS THE WRONG ONE. Revoking an invitation is an act on
   * the workspace's membership, so it is gated by the workspace matrix exactly as it is in the
   * Members panel — an agent administrator who could withdraw a workspace invitation would be
   * reaching outside the agent they administer, which is the boundary the whole feature is about.
   */
  canManage: boolean;
}) {
  const openWorkspace = useUiStore((s) => s.openWorkspacePanel);

  if (invites.length === 0) {
    return (
      <div className="space-y-1">
        <div className="text-tiny text-faint">Nobody is waiting to join this workspace.</div>
        {canManage && (
          <button
            type="button"
            onClick={() => openWorkspace("members")}
            className="text-tiny text-muted underline decoration-dotted hover:text-ink"
          >
            Invite somebody to the workspace
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* §12.1's sentence, at the top rather than in a dialog, because there is no dialog here and
          the warning still has to be said: these are invitations to the WORKSPACE. Accepting one
          makes somebody a member with a role, and that role is a ceiling over every agent — not
          only this one. */}
      <p className="text-tiny leading-[1.5] text-muted">
        These are invitations to the <span className="text-ink">workspace</span>. Accepting one makes
        somebody a member with a role, which is a ceiling over every agent here — not only this one.
      </p>

      {invites.map((invite) => (
        <div
          key={invite.id}
          className="flex min-w-0 items-center gap-2 rounded-control px-1 py-1.5 transition-colors hover:bg-active/40"
        >
          <TicketIcon size={ICON.xs} className="shrink-0 text-faint" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {/* NULL IS "ANYONE WITH THE LINK", AND IT IS A DIFFERENT SENTENCE rather than a blank.
                  An address is a reminder of who to chase; a link invitation is a credential that
                  works for whoever holds it, which is a warning. */}
              <Truncate className="min-w-0 text-caption text-ink">
                {invite.email ?? "Anyone with the link"}
              </Truncate>
              <Chip size="sm" caps tone="faint" variant="bare">
                {invite.role}
              </Chip>
              {/* §12 — A STALE INVITATION IS UNCLAIMED ACCESS SITTING IN SOMEBODY'S INBOX. Seven
                  days is decided by the server so one clock decides, and so this marker cannot
                  disagree with the warning dot on the tab. */}
              {invite.stale && (
                <span
                  className="flex shrink-0 items-center gap-1 text-tiny"
                  style={{ color: STATUS.pending }}
                  title="Sent more than seven days ago and still unaccepted"
                >
                  <AlertTriangleIcon size={ICON.xs} /> stale
                </span>
              )}
            </div>
            <div className="text-tiny text-faint" title={absTime(invite.createdAt)}>
              sent {relTime(invite.createdAt)} · expires {relTime(invite.expiresAt)}
            </div>
          </div>

          {canManage && (
            <button type="button" className={quietBtn} onClick={() => sendRevokeInvite(invite.id)}>
              Revoke
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

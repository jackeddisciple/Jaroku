// §9's sixth tab: who can reach this agent, through Jaroku and around it.
//
// WHERE IT SITS. §9.1 puts Access last among the agent detail view's tabs — Capabilities, Health,
// Deploy, Evals, Threads & runs, and now this. That is the right home rather than the right-panel
// rail beside Secrets, and the difference matters: the rail's tabs are workspace-level surfaces
// (the MCP registry, the credential vault, the usage figures) and every section here is about ONE
// agent. A tab in the rail would have had to invent an "which agent?" control that the detail view
// already answers by existing.
//
// NO PASSCODE GATE, unlike Secrets. Nothing on this surface is a credential: it is a list of who
// may do what, a statement about a URL, and a log of changes. §9.2 is explicit — reading who has
// access is a normal operation and changing it requires the `admin` capability, so the tab renders
// READ-ONLY without it rather than hiding. "Who can deploy this?" is a question a member should be
// able to answer without asking an admin; hiding the answer produces exactly the Slack thread this
// tab exists to eliminate.
//
// FIVE COLLAPSIBLE REGIONS, using the same `CollapsibleRegion` the GitHub panel's four use — the
// per-section collapse pattern from v0.1.11. Each is independently foldable because they are read
// at different times: People on a Tuesday when somebody joins, Exposure when somebody asks what is
// on the internet, History when something has already gone wrong.

import { useEffect, useState } from "react";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { AccessPeople } from "./AccessPeople.tsx";
import { GrantDialog } from "./GrantDialog.tsx";
import { AccessExposure } from "./AccessExposure.tsx";
import { AccessSessions } from "./AccessSessions.tsx";
import { AccessInvites } from "./AccessInvites.tsx";
import { AccessHistory } from "./AccessHistory.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { AlertTriangleIcon, LockIcon } from "./panelIcons.tsx";
import { quietBtn } from "./buttons.ts";
import {
  sendEndSession, sendLoadAccess, sendLoadAccessHistory, sendLoadExposure, sendLoadSessions,
  sendRevokeGrant,
} from "../lib/socket.ts";
import { STATUS, TYPE } from "../lib/tokens.ts";
import { accessFor, useAccessStore, type AccessPerson } from "../store/accessStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useCanRun, useCapability } from "../lib/useCapability.ts";
import type { AgentDetailView } from "../types.ts";

export function AccessPanel({ detail }: { detail: AgentDetailView }) {
  const agentUuid = detail.card.uuid;
  const access = useAccessStore((s) => accessFor(s, agentUuid));
  const loading = useAccessStore((s) => s.loading[agentUuid] ?? false);
  const error = useAccessStore((s) => s.error);
  const exposure = useAccessStore((s) => s.exposure[agentUuid]);
  const sessions = useAccessStore((s) => s.sessions[agentUuid]);
  const history = useAccessStore((s) => s.history[agentUuid]);
  // §12 — revoking a WORKSPACE invitation is `member:manage`, the owner's, and not this panel's
  // agent-level `admin`. An agent administrator who could withdraw a workspace invitation would be
  // reaching outside the agent they administer, which is the boundary the whole feature is about.
  const canManageInvites = useCanRun("revokeInvite");
  const setAccessAgentId = useUiStore((s) => s.setAccessAgentId);

  // §9.2 — `admin` ON THIS AGENT, not a workspace role. A workspace admin holds it by default and a
  // member does not, but a member GRANTED it here does — which is the entire reason the argument
  // exists. Read through the same hook every other guard in the client uses.
  const canAdmin = useCapability("admin", agentUuid);

  /**
   * WHICH AGENT'S PANEL IS OPEN, so §7's recheck knows whether to refetch anything.
   *
   * The recheck carries no agent id — deliberately, see the server's `AccessEvent` — so the socket
   * cannot work out what to reload from the message. It reads this instead, and refetches exactly
   * one agent: the one somebody is looking at. Refetching every agent ever opened would turn one
   * administrator's click into a burst of reads from every tab in the workspace.
   *
   * CLEARED ON UNMOUNT, which is what stops a closed tab going on refetching forever.
   */
  useEffect(() => {
    setAccessAgentId(agentUuid);
    return () => setAccessAgentId(null);
  }, [agentUuid, setAccessAgentId]);

  // The detail pane already asked for the ACCESS when it opened — see AgentDetail — so this is the
  // retry path and the case where somebody reached the tab without the pane having mounted.
  useEffect(() => {
    if (!access && !loading) sendLoadAccess(agentUuid);
  }, [agentUuid, access, loading]);

  // EXPOSURE AND SESSIONS ARE ASKED FOR HERE AND NOT BY THE DETAIL PANE, which is the one place the
  // two fetches differ. The grant feeds every guard in the client, so it is worth fetching whenever
  // an agent opens; these two feed nothing but this panel, and a socket list nobody is looking at
  // is a read that goes stale before anybody sees it.
  useEffect(() => {
    // EXPOSURE ONLY IF THE DETAIL PANE HAS NOT ALREADY ASKED. It fetches on open because the tab's
    // badge is drawn from it — see AgentDetail — so asking again here would be a second read of
    // the same row every time somebody clicked the tab.
    if (!exposure) sendLoadExposure(agentUuid);
    sendLoadSessions(agentUuid);
  }, [agentUuid, exposure]);

  // §15 — ASKED FOR ONLY BY SOMEBODY WHO MAY READ IT. The server refuses `loadAccessHistory`
  // without the agent-level `admin` capability regardless, so sending it anyway would put a
  // refusal in the panel's error strip every time a member opened the tab — a red line about
  // something they never asked for.
  useEffect(() => {
    if (canAdmin) sendLoadAccessHistory(agentUuid);
  }, [agentUuid, canAdmin]);

  // ...and again when the cache is emptied, which is what §7's recheck does. `sessions` going
  // undefined is the signal — the store cleared it, and this is the panel noticing.
  useEffect(() => {
    if (!sessions) sendLoadSessions(agentUuid);
  }, [agentUuid, sessions]);

  useEffect(() => {
    if (canAdmin && !history) sendLoadAccessHistory(agentUuid);
  }, [agentUuid, canAdmin, history]);

  const [open, setOpen] = useState<Record<string, boolean>>({ people: true });
  const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));

  /**
   * The dialog, in three states rather than two booleans.
   *
   * `null` is closed, `{ editing: null }` is a new grant, `{ editing: person }` is §11.2's
   * pre-populated edit. One value rather than an `open` flag plus a `subject`, because those two
   * can disagree — an open dialog with a stale subject is how somebody edits the wrong person's
   * grant, and it is invisible in review because both fields look correct on their own.
   */
  const [dialog, setDialog] = useState<{ editing: AccessPerson | null } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AccessPerson | null>(null);

  const onGrant = (): void => setDialog({ editing: null });
  const onEdit = (person: AccessPerson): void => setDialog({ editing: person });
  const onRevoke = (person: AccessPerson): void => setConfirmRevoke(person);

  if (!access) {
    return loading ? (
      // NOT A SPINNER (§9). Skeleton at the real geometry so the panel does not jump when the
      // answer lands — the same treatment the detail pane around it uses.
      <div className="space-y-3 p-4">
        <div className="h-4 w-1/3 rounded-chip bg-active" />
        <div className="h-3 w-1/2 rounded-chip bg-active" />
        <div className="h-3 w-2/3 rounded-chip bg-active" />
      </div>
    ) : (
      <EmptyState
        icon={AlertTriangleIcon}
        title="Access could not be read"
        hint={
          <>
            <span>{error ?? "Nothing came back for this agent."}</span>
            <button
              onClick={() => sendLoadAccess(agentUuid)}
              className="ml-2 text-muted underline decoration-dotted hover:text-ink"
            >
              Try again
            </button>
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-5 p-4">
      {/* §9.2's read-only notice, and it says WHY rather than merely that. "You do not have
          permission" is a dead end; naming the capability and where it comes from is the difference
          between a wall and a next step — and it is one sentence, once, rather than a disabled
          control on every row. */}
      {!canAdmin && (
        <div className="flex items-start gap-2 rounded-control border border-hair px-2.5 py-2 text-tiny text-muted">
          <LockIcon size={12} className="mt-0.5 shrink-0 text-faint" />
          <span>
            You can read this, and not change it. Managing access needs the{" "}
            <span className="text-ink">admin</span> capability on this agent — an
            administrator of it can grant that.
          </span>
        </div>
      )}

      {/* The refusal from a mutation, which is the one error a panel this wide has to surface
          inline: a grant refused for a note or a ceiling is something the person can fix. */}
      {error && (
        <div
          className="rounded-control border border-hair px-2.5 py-2 text-tiny"
          style={{ color: STATUS.error }}
          role="alert"
        >
          {error}
        </div>
      )}

      <CollapsibleRegion
        label="People"
        count={access.people.length + access.orphans.length}
        open={open["people"] !== false}
        onToggle={() => toggle("people")}
      >
        <AccessPeople access={access} canAdmin={canAdmin} onGrant={onGrant} onEdit={onEdit} onRevoke={onRevoke} />
      </CollapsibleRegion>

      {/* §13.2 — ALWAYS RENDERED, deployed or not. A section that disappeared when nothing was on
          the internet would have its absence read as safety, which is the one conclusion nobody
          should draw from silence about what is reachable. */}
      <CollapsibleRegion
        label="Exposure"
        open={open["exposure"] !== false}
        onToggle={() => toggle("exposure")}
      >
        <AccessExposure exposure={exposure} />
      </CollapsibleRegion>

      {/* §12 — the workspace's open invitations. Between the people who HAVE access and what is
          reachable without it, because that is where they belong: somebody about to have access. */}
      <CollapsibleRegion
        label="Pending invites"
        count={access.invites.length}
        open={open["invites"] !== false}
        onToggle={() => toggle("invites")}
      >
        <AccessInvites invites={access.invites} canManage={canManageInvites} />
      </CollapsibleRegion>

      {/* §14.1's count is the section's own, so it is legible before anybody expands it. */}
      <CollapsibleRegion
        label="Live sessions"
        count={sessions?.length}
        open={open["sessions"] !== false}
        onToggle={() => toggle("sessions")}
      >
        <AccessSessions
          sessions={sessions}
          canAdmin={canAdmin}
          onEnd={(sessionId) => sendEndSession(access.agentId, sessionId)}
        />
      </CollapsibleRegion>

      {/* §15 — ADMIN ONLY, AND ABSENT RATHER THAN EMPTY for everybody else. A History section
          rendering nothing would read as "nothing has ever happened to this agent", which is a
          claim rather than an absence — and it is the one claim on this surface that would be most
          reassuring and most likely to be false. */}
      {canAdmin && (
        <CollapsibleRegion
          label="History"
          count={history?.length}
          open={open["history"] !== false}
          onToggle={() => toggle("history")}
        >
          <AccessHistory entries={history} agentSlug={access.agentSlug} />
        </CollapsibleRegion>
      )}

      {dialog && (
        <GrantDialog
          agentId={access.agentId}
          agentSlug={access.agentSlug}
          editing={dialog.editing}
          // §11.1 — "workspace members who don't already have a per-agent grant". Offering somebody
          // who already has one would turn a Grant into a silent overwrite of a grant somebody else
          // wrote, with no record on this screen that it existed. Editing is how that is changed,
          // and it is reached from their row.
          candidates={
            dialog.editing
              ? access.people.filter((p) => p.user_id === dialog.editing?.user_id)
              : access.people.filter((p) => p.provenance === "role")
          }
          onClose={() => setDialog(null)}
        />
      )}

      {confirmRevoke && (
        <RevokeDialog
          person={confirmRevoke}
          agentSlug={access.agentSlug}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => {
            sendRevokeGrant(access.agentId, confirmRevoke.user_id);
            setConfirmRevoke(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * §11.3 — revoking, and saying what it will actually do.
 *
 * THE CONSEQUENCE IS IN THE BODY, NOT THE TITLE. §17 asks for that on every destructive action here
 * and it is not a formality: "Revoke access?" is a question somebody answers from the button they
 * pressed, and the thing they need to know is what happens to a colleague who is using the agent
 * right now. So the body names them, says whether they are connected, and says when it takes
 * effect — on their NEXT command, because a command already in flight is allowed to finish (§5.2:
 * killing a half-completed publish to enforce a permission change trades a small authorisation
 * window for a corrupted agent).
 *
 * AND IT SAYS WHAT REVOKING LEAVES BEHIND. A grant is not somebody's whole access — revoking it
 * drops them back to their workspace role, which may still be quite a lot. An admin who thinks
 * this removes a person from the agent and finds them still able to run it has been misled by a
 * dialog, not by the feature.
 */
function RevokeDialog({
  person,
  agentSlug,
  onCancel,
  onConfirm,
}: {
  person: AccessPerson;
  agentSlug: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const who = person.display_name || person.email;
  const fallback = person.role
    ? `They keep whatever their ${person.role} role gives them on this agent.`
    : "They are no longer in this workspace, so this removes a grant that already resolves to nothing.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Revoke ${who}'s grant on ${agentSlug}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4"
    >
      <div className="w-full max-w-md rounded-modal border border-edge bg-elevated p-4 shadow-overlay">
        <div className={TYPE.sectionLabel}>Revoke access</div>
        <p className="mt-2 text-caption leading-[1.55] text-ink">
          Revoke <span className="text-ink">{who}</span>&apos;s grant on{" "}
          <span className="text-ink">{agentSlug}</span>?
        </p>
        {/* §11.3 — when somebody is connected, the confirmation states the consequence rather than
            leaving an admin to wonder whether a live session is unaffected. It is not: the next
            command that session sends re-resolves and is refused. */}
        {person.live && (
          <p className="mt-1.5 text-tiny leading-[1.55]" style={{ color: STATUS.pending }}>
            {who} is connected right now. Revoking ends their granted access on their next command —
            anything already running finishes.
          </p>
        )}
        <p className="mt-1.5 text-tiny leading-[1.55] text-muted">{fallback}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onConfirm}
            className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-caption text-err transition-colors hover:bg-err/20"
          >
            Revoke
          </button>
          <button onClick={onCancel} className={quietBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

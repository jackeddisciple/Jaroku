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
import { EmptyState } from "./EmptyState.tsx";
import { AlertTriangleIcon, LockIcon } from "./panelIcons.tsx";
import { sendLoadAccess } from "../lib/socket.ts";
import { STATUS } from "../lib/tokens.ts";
import { accessFor, useAccessStore, type AccessPerson } from "../store/accessStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useCapability } from "../lib/useCapability.ts";
import type { AgentDetailView } from "../types.ts";

export function AccessPanel({ detail }: { detail: AgentDetailView }) {
  const agentUuid = detail.card.uuid;
  const access = useAccessStore((s) => accessFor(s, agentUuid));
  const loading = useAccessStore((s) => s.loading[agentUuid] ?? false);
  const error = useAccessStore((s) => s.error);
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

  // The detail pane already asked when it opened — see AgentDetail — so this is the retry path and
  // the case where somebody reached the tab without the pane having mounted.
  useEffect(() => {
    if (!access && !loading) sendLoadAccess(agentUuid);
  }, [agentUuid, access, loading]);

  const [open, setOpen] = useState<Record<string, boolean>>({ people: true });
  const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const onGrant = (): void => undefined;
  const onEdit = (_person: AccessPerson): void => undefined;
  const onRevoke = (_person: AccessPerson): void => undefined;

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
    </div>
  );
}

// §12.1 — inviting somebody to the WORKSPACE, with a grant on one agent waiting for them.
//
// THE SENTENCE IS THE FEATURE. §12.1 names the failure this dialog exists to prevent, in bold, and
// it is worth restating because it is the kind of mistake nobody notices making: "an admin must
// never think they've granted narrow agent access when they've actually widened the tenancy". A
// dialog reached from an agent's Access tab, headed "Invite", with a list of that agent's
// capabilities under it, reads as inviting somebody TO THE AGENT. It is not. It adds a member to
// the workspace, with a role, which is a ceiling over every agent in it — and the grant merely
// narrows them on this one.
//
// So the confirming line is assembled from the three real values and shown before the button, in
// §12.1's own shape: "This will invite [email] to join [workspace] and grant them [capabilities] on
// [agent]." Not a tooltip, not a footnote — the sentence somebody reads immediately above the
// control that does it.
//
// THE CEILING IS THE ROLE BEING INVITED, which is the one thing about validating a grant with no
// member behind it yet. An owner staging `deploy` on somebody they are inviting as a member is
// describing a state that can never exist, so those boxes are disabled with a reason, exactly as
// they are in the grant dialog — and the server refuses the same set for the same reason.

import { useMemo, useState } from "react";
import { CheckboxField } from "./Checkbox.tsx";
import { Select } from "./Select.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { sendInviteMember } from "../lib/socket.ts";
import {
  AGENT_CAPABILITIES, agentCeiling, closeAgentCapabilities, type AgentCapability,
} from "../lib/capabilities.ts";
import { STATUS, TYPE } from "../lib/tokens.ts";

/** The three roles an invitation can carry. The workspace matrix's own, in the same order. */
const ROLES = [
  { value: "member", label: "Member — build, run, edit and evaluate agents" },
  { value: "admin", label: "Admin — …and keys, servers, repositories and deployments" },
  { value: "owner", label: "Owner — …and membership, billing, and the workspace itself" },
];

/** §11.1's three, which need a stated reason here for the same reason they do there. */
const NOTE_REQUIRED: readonly AgentCapability[] = ["deploy", "secrets", "admin"];

export function InviteWithGrantDialog({
  agentId,
  agentSlug,
  workspaceName,
  onClose,
}: {
  agentId: string;
  agentSlug: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [chosen, setChosen] = useState<Set<AgentCapability>>(() => closeAgentCapabilities(["view"]));
  const [note, setNote] = useState("");

  const ceiling = useMemo(() => agentCeiling(role), [role]);
  const asked = [...chosen].filter((c) => ceiling.has(c));
  const needsNote = asked.some((c) => NOTE_REQUIRED.includes(c));
  const canSubmit = asked.length > 0 && !(needsNote && note.trim() === "");

  // The same toggle the grant dialog uses, and for the same reason: the implication rules are the
  // matrix's, applied by one function, so the set on screen cannot differ from the set stored.
  const toggle = (capability: AgentCapability): void => {
    setChosen((current) => {
      if (current.has(capability)) {
        const without = [...current].filter((c) => c !== capability);
        return closeAgentCapabilities(without.filter((c) => !closeAgentCapabilities([c]).has(capability)));
      }
      return closeAgentCapabilities([...current, capability]);
    });
  };

  const submit = (): void => {
    sendInviteMember(email.trim() || null, role, {
      agentId,
      capabilities: asked,
      note: note.trim() || null,
    });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Invite somebody to ${workspaceName} with access to ${agentSlug}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4"
    >
      <div className="w-full max-w-lg rounded-modal border border-edge bg-elevated p-4 shadow-overlay">
        <div className={TYPE.sectionLabel}>Invite to workspace</div>

        <label className="mt-2 block">
          <span className="text-tiny text-muted">Email</span>
          <input
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // AN EMPTY ADDRESS IS §13.4's LINK INVITATION, which is a real choice rather than a
            // blank field — and the placeholder says so, because a shareable credential handed to
            // somebody who thought they were writing to one person is the worst version of this.
            placeholder="leave empty for a link anyone can open"
            aria-label="Who to invite, or empty for a link"
            className="mt-1 w-full rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-tiny text-muted">Workspace role</span>
          <Select value={role} onChange={setRole} ariaLabel="Workspace role" options={ROLES} />
        </label>

        <fieldset className="mt-3">
          <legend className="text-tiny text-muted">Access to {agentSlug}</legend>
          <div className="mt-1 space-y-1">
            {AGENT_CAPABILITIES.map((capability) => {
              const overCeiling = !ceiling.has(capability);
              const reasonId = `invite-ceiling-${capability}`;
              return (
                <div key={capability}>
                  <CheckboxField
                    checked={chosen.has(capability) && !overCeiling}
                    disabled={overCeiling}
                    onChange={() => toggle(capability)}
                    describedBy={overCeiling ? reasonId : undefined}
                  >
                    {capability}
                  </CheckboxField>
                  {overCeiling && (
                    <p id={reasonId} className="ml-6 text-tiny" style={{ color: STATUS.error }}>
                      {capability} exceeds the {role} role this invitation carries — invite them at a
                      higher role, or leave it off
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <label className="mt-3 block">
          <span className="text-tiny text-muted">
            Note
            {needsNote && (
              <span style={{ color: STATUS.error }}>
                {" "}
                · required for {asked.filter((c) => NOTE_REQUIRED.includes(c)).join(", ")}
              </span>
            )}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="why they need this"
            aria-label="Why this grant exists"
            className="mt-1 w-full rounded-control border border-hair bg-void px-2.5 py-1.5 text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
          />
        </label>

        {/* §12.1's SENTENCE, immediately above the button that does it, built from the three real
            values. The word "workspace" is in it twice on purpose. */}
        <p className="mt-3 rounded-control border border-hair px-2.5 py-2 text-caption leading-[1.55] text-ink">
          This will invite <span className="text-ink">{email.trim() || "anyone with the link"}</span>{" "}
          to join the <span className="text-ink">{workspaceName}</span> workspace as a{" "}
          <span className="text-ink">{role}</span>, and grant them{" "}
          <span className="text-ink">{asked.join(", ") || "nothing"}</span> on{" "}
          <span className="text-ink">{agentSlug}</span>.
        </p>
        <p className="mt-1.5 text-tiny leading-[1.55] text-muted">
          Their {role} role is a ceiling over <em>every</em> agent in this workspace. The grant above
          narrows them on {agentSlug} only.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={submit} disabled={!canSubmit} className={primaryBtn}>
            Invite
          </button>
          <button onClick={onClose} className={quietBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

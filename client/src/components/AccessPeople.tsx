// §10 — who can do what to this agent, and WHY each of them can.
//
// THE PROVENANCE LINE IS THE ENTIRE POINT OF THIS SECTION and everything else here is in service
// of it. A list of names with permission badges is a report: it tells an admin what is true and
// leaves them to work out what to do about it. This list answers the second question on every row —
// inherited from a workspace role, granted specifically here, or granted and then capped by a role
// — because those three facts have three different remedies, and an admin who cannot tell them
// apart will revoke a grant that was never the reason, or change a role over something a grant
// could have fixed.
//
// THE AVATAR, THE NAME AND THE COLOUR COME FROM `memberList.ts`, which is the Members panel's own
// module. §10.1 says not to build a parallel renderer and the reason is stronger than consistency:
// the colour is a MNEMONIC — it is what makes a row findable again once somebody has seen it — and
// two hashes producing two colours for one person across two panels would destroy exactly the
// property the colour exists for.
//
// EVERY MUTATION CONTROL IS ABSENT RATHER THAN DISABLED for a non-admin, which is §8's rule and
// v0.4.0's frozen decision. The one exception in this file is the Revoke button on a last
// administrator, and §11.4 argues it: that control is blocked by a STATE rather than by authority,
// and a control that vanished on a state would read as "there is nothing to revoke", which is the
// opposite of what is true.

import { useMemo, useState } from "react";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { quietBtn, secondaryBtn } from "./buttons.ts";
import { AlertTriangleIcon, UserPlusIcon } from "./panelIcons.tsx";
import { avatarColor, avatarLetter } from "../lib/memberList.ts";
import { absTime, relTime, relUntil } from "../lib/format.ts";
import { AGENT_CAPABILITIES } from "../lib/capabilities.ts";
import {
  cappedLine, chipsFor, matchesAccess, orderAccess, provenanceLine, revokeBlockedReason,
} from "../lib/accessList.ts";
import { ACCENT, ICON, STATUS, TEXT, TYPE } from "../lib/tokens.ts";

import type { AccessPerson, AgentAccess } from "../store/accessStore.ts";

/**
 * One capability, drawn so that colour is never the only signal.
 *
 * §17: "granted-here carries a `+`, capped carries an icon plus tooltip text". Both marks are in
 * the label rather than in a wrapper, so they survive a copy-paste out of the panel and are read
 * aloud in order by a screen reader — a `+` announced as part of the chip's text is the difference
 * between "plus deploy" and a colour nobody can hear.
 */
function CapabilityChip({
  capability,
  kind,
  reason,
}: {
  capability: string;
  kind: "role" | "granted" | "capped";
  reason?: string;
}) {
  if (kind === "capped") {
    return (
      <Chip
        size="sm"
        color={STATUS.error}
        icon={<AlertTriangleIcon size={ICON.xs} />}
        title={reason}
        className="line-through"
      >
        {capability}
      </Chip>
    );
  }
  return (
    <Chip
      size="sm"
      // Accented for a capability given HERE and neutral for one that came with the role. The `+`
      // is what actually distinguishes them; the colour is what makes a row scannable.
      color={kind === "granted" ? ACCENT.state : undefined}
      tone={kind === "granted" ? "ink" : "muted"}
      title={
        kind === "granted"
          ? `${capability} was granted on this agent specifically`
          : `${capability} comes from their workspace role`
      }
    >
      {kind === "granted" ? `+${capability}` : capability}
    </Chip>
  );
}

function PersonRow({
  person,
  everyone,
  canAdmin,
  onEdit,
  onRevoke,
}: {
  person: AccessPerson;
  everyone: readonly AccessPerson[];
  canAdmin: boolean;
  onEdit: (person: AccessPerson) => void;
  onRevoke: (person: AccessPerson) => void;
}) {
  const chips = chipsFor(person, AGENT_CAPABILITIES);
  const capped = cappedLine(person);
  const blocked = revokeBlockedReason(person, everyone);
  // §10.4 — Edit and Revoke belong to a row that HAS a grant. Somebody whose access is entirely
  // their workspace role has nothing here to revoke, and offering it would send an admin to this
  // panel to do something only the Members panel can do.
  const hasGrant = person.provenance === "grant" || person.provenance === "expired";

  return (
    <div className="flex min-w-0 gap-2 rounded-control px-1 py-2 transition-colors hover:bg-active/40">
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-tiny text-void"
        style={{ background: avatarColor(person.user_id) }}
        aria-hidden
      >
        {avatarLetter(person)}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Truncate className="min-w-0 text-caption text-ink" title={person.email}>
            {person.display_name || person.email || person.user_id}
          </Truncate>
          {person.role && (
            <Chip size="sm" caps tone="faint" variant="bare">
              {person.role}
            </Chip>
          )}
          {/* §10.2's presence dot. A DOT PLUS A WORD, never a dot alone: a coloured circle says
              nothing to a screen reader and nothing to somebody who cannot separate it from the
              seven other marks on this row. */}
          {person.live && (
            <span
              className="flex shrink-0 items-center gap-1 text-tiny"
              style={{ color: STATUS.ok }}
              title="They have a Jaroku session open right now"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS.ok }} aria-hidden />
              live
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {chips.length === 0 ? (
            // AN EMPTY SET IS A REAL ANSWER AND IT IS SAID IN WORDS. A row with no chips reads as a
            // rendering failure; "no access to this agent" is a narrowing grant working exactly as
            // somebody intended.
            <span className="text-tiny" style={{ color: TEXT.disabled }}>
              no access to this agent
            </span>
          ) : (
            chips.map(({ capability, kind }) => (
              <CapabilityChip
                key={capability}
                capability={capability}
                kind={kind}
                reason={kind === "capped" ? capped : undefined}
              />
            ))
          )}
        </div>

        <div className="text-tiny text-faint" title={person.granted_at ? absTime(person.granted_at) : undefined}>
          {provenanceLine(person, { ago: relTime, until: relUntil })}
        </div>
        {capped && (
          <div className="flex items-start gap-1 text-tiny" style={{ color: STATUS.error }}>
            <AlertTriangleIcon size={ICON.xs} className="mt-0.5 shrink-0" />
            <span>{capped}</span>
          </div>
        )}
        {/* THE NOTE IS SHOWN, not hidden behind a tooltip. §11.1 requires one for deploy, secrets
            and admin precisely so that "why does this contractor have deploy" has an answer six
            months later — and an answer nobody can see without hovering is one nobody reads. */}
        {person.note && <div className="text-tiny italic text-muted">“{person.note}”</div>}
      </div>

      {canAdmin && hasGrant && (
        <div className="flex shrink-0 items-start gap-1">
          <button type="button" className={quietBtn} onClick={() => onEdit(person)}>
            Edit
          </button>
          {/* DISABLED WITH A REASON rather than absent — see `revokeBlockedReason`. The reason is on
              the control itself, so it is reachable by pointer and by assistive tech without having
              to click something that does nothing. */}
          <button
            type="button"
            className={quietBtn}
            disabled={Boolean(blocked)}
            title={blocked ?? "Revoke this grant"}
            aria-describedby={blocked ? `revoke-blocked-${person.user_id}` : undefined}
            onClick={() => onRevoke(person)}
          >
            Revoke
          </button>
          {blocked && (
            <span id={`revoke-blocked-${person.user_id}`} className="sr-only">
              {blocked}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function AccessPeople({
  access,
  canAdmin,
  onGrant,
  onEdit,
  onRevoke,
}: {
  access: AgentAccess;
  canAdmin: boolean;
  onGrant: () => void;
  onEdit: (person: AccessPerson) => void;
  onRevoke: (person: AccessPerson) => void;
}) {
  const [query, setQuery] = useState("");


  const rows = useMemo(
    () => orderAccess(access.people).filter((p) => matchesAccess(p, query)),
    [access.people, query],
  );
  const orphans = useMemo(() => orderAccess(access.orphans), [access.orphans]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {/* ONE FIELD FOR NAMES AND CAPABILITIES — see `matchesAccess` for why this is not a search
            box plus a filter dropdown. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a person, or a capability"
          aria-label="Filter by name or capability"
          className="min-w-0 flex-1 rounded-control border border-hair bg-transparent px-2 py-1 text-tiny text-ink placeholder:text-faint focus-visible:outline-none focus-visible:shadow-focusring"
        />
        {/* §10.4 — ABSENT for a non-admin, not disabled. */}
        {canAdmin && (
          <button type="button" className={secondaryBtn} onClick={onGrant}>
            <UserPlusIcon size={ICON.xs} /> Grant
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={UserPlusIcon}
          title={query ? "Nobody matches that" : "Nobody has access to this agent"}
          hint={
            query
              ? "Search matches a name, an address, a workspace role, or one of the seven capabilities."
              : undefined
          }
        />
      ) : (
        <div className="space-y-0.5">
          {rows.map((p) => (
            <PersonRow
              key={p.user_id}
              person={p}
              everyone={access.people}
              // NO SPECIAL CASE FOR THE VIEWER'S OWN ROW, and §11.4 is why: "revoking your own
              // non-admin capabilities is allowed — that's a legitimate drop-my-own-access action",
              // and what stops somebody removing their own admin is the LAST-ADMIN guard, which is
              // the same guard that applies to everybody else. One rule, no exception about the
              // self, and the server enforces the identical thing.
              canAdmin={canAdmin}
              onEdit={onEdit}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      )}

      {/* §16 — GRANTS FOR PEOPLE WHO HAVE LEFT. They resolve to empty and they are still here,
          because a grant nobody can use is a row somebody has to decide about: it comes back the
          day that person is re-invited, with whatever it said when they left. */}
      {orphans.length > 0 && (
        <div className="space-y-0.5 pt-2">
          <div className={TYPE.sectionLabel}>No longer in this workspace</div>
          <p className="text-tiny text-faint">
            These grants resolve to nothing while the person is not a member — and would apply again
            if they rejoined. Revoke them if that is not what you want.
          </p>
          {orphans.map((p) => (
            <PersonRow
              key={p.user_id}
              person={p}
              everyone={access.people}
              canAdmin={canAdmin}
              onEdit={onEdit}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      )}
    </div>
  );
}

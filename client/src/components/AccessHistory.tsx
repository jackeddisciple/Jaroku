// §15 — what changed about who can reach this agent, and which changes were not about this agent.
//
// THE TWO SCOPES ARE THE SECTION'S WHOLE VALUE. An agent-scoped row is somebody acting on this
// agent: a grant written, edited, revoked, a command refused, a session ended. A workspace row is
// somebody acting on the WORKSPACE — a role changed, a member removed — which changes effective
// access to every agent at once and carries no agent id at all. §15 asks for a distinct mark on the
// second, and the reason is exactly the reason the People section carries a provenance line: an
// admin looking at "Sam can no longer deploy" needs to know whether somebody revoked Sam's grant
// or demoted Sam, because the two have different remedies and only one of them is fixable here.
//
// READS `audit_log` AND IS NOT A NEW STORE, which is §15's own instruction and the right one: the
// rows are already written by the grant handlers and by the membership mutations, and a table of
// its own would be a second record of the same events that disagrees the first time one of them is
// written inside a transaction that rolls back.
//
// ADMIN ONLY. §15: "Non-admins do not see History." The rows name who granted what to whom and what
// somebody was refused, which is the same class of fact the workspace audit log restricts to an
// owner — and the server refuses `loadAccessHistory` without the capability regardless, so this is
// what stops a section rendering an empty list and reading as "nothing has happened".

import { Truncate } from "./Truncate.tsx";
import { quietBtn } from "./buttons.ts";
import { GitBranchIcon, ShieldIcon } from "./panelIcons.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { download } from "../lib/evalExport.ts";
import { historyToCsv } from "../lib/accessList.ts";
import { ICON } from "../lib/tokens.ts";
import type { AccessHistoryEntry } from "../store/accessStore.ts";

export function AccessHistory({
  entries,
  agentSlug,
}: {
  entries: AccessHistoryEntry[] | undefined;
  agentSlug: string;
}) {
  if (!entries) return <div className="text-tiny text-faint">Reading what has changed…</div>;

  if (entries.length === 0) {
    return <div className="text-tiny text-faint">Nothing has changed about access to this agent.</div>;
  }

  return (
    <div className="space-y-1">
      <div className="space-y-0.5">
        {entries.map((e) => (
          <div key={e.id} className="flex min-w-0 items-start gap-2 rounded-control px-1 py-1">
            {/* §15's DISTINCT ICON, and it is a distinct GLYPH rather than a distinct colour: the
                difference between "somebody changed this agent" and "somebody changed the
                workspace, which affected this agent" has to survive a screen nobody is looking
                closely at, and the title says it in words for everything else. */}
            {e.scope === "workspace" ? (
              <GitBranchIcon
                size={ICON.xs}
                className="mt-0.5 shrink-0 text-faint"
                label="A workspace change that affected access to this agent"
              />
            ) : (
              <ShieldIcon
                size={ICON.xs}
                className="mt-0.5 shrink-0 text-faint"
                label="A change to this agent's access"
              />
            )}
            <div className="min-w-0 flex-1">
              <Truncate className="min-w-0 text-tiny text-ink">
                {e.actorName} {e.summary}
              </Truncate>
              {e.scope === "workspace" && (
                <div className="text-tiny text-faint">
                  a workspace change — it affected this agent rather than being about it
                </div>
              )}
            </div>
            <span className="shrink-0 text-tiny text-faint" title={absTime(e.createdAt)}>
              {relTime(e.createdAt)}
            </span>
          </div>
        ))}
      </div>

      {/* §15's export, at the bottom of the section. A CSV rather than a JSON dump, because what
          this is for is being pasted into a document somebody is writing about an incident. */}
      <button
        type="button"
        className={quietBtn}
        onClick={() => download(`jaroku-access-${agentSlug}.csv`, historyToCsv(entries), "text/csv")}
      >
        Export CSV
      </button>
    </div>
  );
}

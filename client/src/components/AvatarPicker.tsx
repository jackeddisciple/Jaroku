// The roster, rendered live, in a grid somebody picks from.
//
// ONE COMPONENT FOR TWO SURFACES — the New agent dialog and the agent detail's identity section —
// because they ask the same question and the answer has to look the same in both. Two grids would
// be two sets of tile sizes, two duplicate warnings and two chances for one of them to stop matching
// what the card actually draws.
//
// RENDERED LIVE, THROUGH THE SAME STAGE THE GRID USES (§6). A picker of static images would be a
// second rendering path to keep in step with the first, and the first is the one whose output people
// are comparing these against. It costs a stage while the picker is open and nothing when it is not.
//
// THE DUPLICATE IS SHOWN, NEVER BLOCKED. §6: "Taking an avatar another agent already uses is allowed
// but warned — the picker shows 'also used by X'. It is their workspace, and a hard block on a
// cosmetic choice is worse than a duplicate."

import { useMemo } from "react";

import { GlossAvatar } from "./GlossAvatar.tsx";
import { Truncate } from "./Truncate.tsx";
import { GLOSS_ROSTER } from "../lib/gloss/roster.ts";

/** The tile. Large enough to tell two characters apart — the size the curation pass judged at. */
const TILE = 84;

export function AvatarPicker({
  current,
  usedBy,
  onChoose,
  columns = 5,
}: {
  current: string | null | undefined;
  /**
   * Roster id → the names already wearing it.
   *
   * BUILT BY THE CALLER, because only the caller knows which agents count: the dialog is choosing
   * for an agent that does not exist yet, and the detail has to leave the agent being edited out of
   * its own warning.
   */
  usedBy: ReadonlyMap<string, readonly string[]>;
  onChoose: (avatarId: string) => void;
  columns?: number;
}) {
  const alsoUsedBy = useMemo(() => (current ? usedBy.get(current) ?? [] : []), [usedBy, current]);

  return (
    <div>
      {/* NO PROVIDER OF ITS OWN. The picker draws into whichever stage is above it, and its two
          callers each own one: the New agent dialog wraps itself, and the agent detail wraps its
          header so the character beside the name and the tiles in this grid share one context.
          A provider here would have made a third — and on the detail, two stages drawing the same
          agent's face a hundred pixels apart. */}
      <div
          role="radiogroup"
          aria-label="Avatar"
          className="grid max-h-[220px] gap-1.5 overflow-y-auto rounded-card border border-hair p-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {GLOSS_ROSTER.map((entry) => {
            const picked = entry.id === current;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={picked}
                aria-label={entry.label}
                onClick={() => onChoose(entry.id)}
                className={`flex flex-col items-center rounded-control p-1 transition-colors duration-fast ${
                  picked ? "bg-active" : "hover:bg-active"
                }`}
              >
                <GlossAvatar
                  // KEYED BY THE PICKER, not by the agent. Two pickers on one screen would otherwise
                  // register the same slot key twice and one of them would draw nowhere.
                  agentKey={`picker:${entry.id}`}
                  avatarId={entry.id}
                  emoji={null}
                  size={TILE}
                />
                <Truncate className="mt-0.5 w-full text-center text-tiny text-faint">
                  {entry.label}
                </Truncate>
              </button>
            );
          })}
      </div>
      {alsoUsedBy.length > 0 && (
        <p className="mt-1.5 text-tiny text-muted">
          Also used by {alsoUsedBy.slice(0, 3).join(", ")}
          {alsoUsedBy.length > 3 ? ` and ${alsoUsedBy.length - 3} more` : ""}.
        </p>
      )}
    </div>
  );
}

/** Roster id → the agents wearing it, for one render pass. Built once rather than once per tile. */
export function avatarUsage(
  agents: readonly { name: string; avatar_id?: string | null }[],
  exclude?: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.avatar_id || a.name === exclude) continue;
    const at = out.get(a.avatar_id) ?? [];
    at.push(a.name);
    out.set(a.avatar_id, at);
  }
  return out;
}

// A file landing on disk, as a line of the build's narrative.
//
// Generation and the fix loop both stream files, and both drew the row by hand before this became
// the one copy. What that copy still did not say was what was HAPPENING to the file: the row was a
// type glyph, a path, a dot and a figure that flipped between a byte count and the word "writing…"
// tucked in on the right, where the eye reads figures rather than verbs.
//
// Now it is an ActionRow like every other narrative line in the app, and the verb leads:
//
//     Writing   agent.py                   ● 1,204 B
//     Wrote     tools/order_lookup.py      ✓   812 B
//     Writes    .env.example               ○    96 B
//
// Three tenses, because a build has three states per file and they are the whole of a progress
// indicator: this one is being written now, this one is finished, this one is still coming. The
// third is new — a queued file used to show a byte count with a pending dot and no way to tell it
// from the one actually streaming.
//
// The icon stays the file's own type rather than a generic write mark. In a list of seven files
// what you scan for is which one is agent.py; that all seven are being written is said by the line
// above them, and now by every verb in the column.

import { actionForFile } from "../lib/actionIcons.tsx";
import { ActionRow, type ActionState } from "./ActionRow.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { STAT_ICON } from "./StatRow.tsx";

/** Present, past, and not-yet — for the two loops that write files. */
function verbFor(state: ActionState, rewrite: boolean): string {
  if (state === "active") return rewrite ? "Rewriting" : "Writing";
  if (state === "done") return rewrite ? "Rewrote" : "Wrote";
  return rewrite ? "Rewrites" : "Writes";
}

export function StreamingFileRow({
  path,
  state,
  bytes,
  rewrite = false,
}: {
  path: string;
  /** `active` while this file is the one streaming, `done` once it closes, else `pending`. */
  state: ActionState;
  /** How much has landed. Shown at every state — a partial count is still information. */
  bytes: number;
  /** The fix loop rewrites files that already exist; generation writes new ones. */
  rewrite?: boolean;
}) {
  return (
    <ActionRow
      action={actionForFile(path)}
      state={state}
      verb={verbFor(state, rewrite)}
      object={<span className="font-mono text-muted [overflow-wrap:anywhere]">{path}</span>}
      trailing={
        <>
          <StatusDot
            state={state === "done" ? "ok" : "pending"}
            pulse={state === "active"}
            size={STAT_ICON}
            title={state === "done" ? (rewrite ? "Rewritten" : "Written") : "Still writing"}
          />
          <span className="font-mono text-faint">{bytes.toLocaleString()} B</span>
        </>
      }
      className="animate-slide-in"
    />
  );
}

// §B.4's two surfaces: a checkbox per hunk, and a draggable unpushed stack.
//
// WHAT THIS FILE DECIDES AND WHAT IT DOES NOT. It decides which hunks are ticked and what order the
// rows are in — both of which are UI state and belong nowhere else. It decides NOTHING about what
// that means: whether a selection still corresponds to one version, whether a reordered history
// validates at every step, which files are protected, and what a hunk even is all arrive from the
// server. The panel's own header states the rule and it holds here: a second implementation in the
// browser would be a second opinion, and the day the two disagree the user is reading the one that
// is wrong.
//
// THE SELECTION IS NOT PERSISTED, and that is deliberate rather than unfinished. A ticked hunk
// describes an intention about a push that is about to happen; §A.5's four collapsed regions are a
// preference about how somebody likes to work. Restoring a selection made yesterday, against hunks
// that have since moved because the agent has three more versions, would tick boxes that mean
// something different from what they meant when they were ticked.
//
// EVERYTHING IS BORROWED VISUALLY, as everywhere else in this panel: the file rows keep the same
// icon-status-path-figures shape ChangesRegion uses, the reorder rows read as the version rows they
// are, and the diff body reuses the ± colouring the DiffCard established in v0.1.0.

import { useEffect, useMemo, useState } from "react";

import { sendPushGithub } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { fileStatusFor } from "../lib/actionIcons.tsx";
import { useGithubStore } from "../store/githubStore.ts";
import type { GithubHunkRow, GithubStagedFile, GithubView } from "../types.ts";
import { iconForPath } from "./fileIcons.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { RegionLabel } from "./GitHubSync.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { ChevronDownIcon } from "./panelIcons.tsx";
import { Checkbox } from "./Checkbox.tsx";

/** `path\u0000index` — one ticked hunk. A set of these is the whole of the staging state. */
type HunkKey = string;

const keyOf = (path: string, index: number): HunkKey => `${path}\u0000${index}`;

/**
 * Everything stageable, ticked.
 *
 * THE DEFAULT IS EVERYTHING, which is git's `commit -a` rather than git's index, and it is the right
 * default here for a reason specific to this product: the ordinary push in Jaroku has always been
 * "send the versions", and a staging area that opened empty would make every push a two-step
 * operation to preserve a feature most people will never use. Unticking is the deliberate act.
 *
 * A LOCKED FILE IS NEVER IN THE SET. §3.3's protected files are listed and never stageable, so they
 * are not "unticked" — there is no box to tick — and including them here would put them in a
 * selection the server then has to strip.
 */
function everything(files: readonly GithubStagedFile[]): Set<HunkKey> {
  const out = new Set<HunkKey>();
  for (const file of files) {
    if (file.locked) continue;
    if (file.hunks.length === 0) out.add(keyOf(file.path, -1)); // a deletion: all-or-nothing
    for (const hunk of file.hunks) out.add(keyOf(file.path, hunk.index));
  }
  return out;
}

/**
 * §B.4.1's staging area, above the commit box.
 *
 * RENDERS NOTHING WHEN THERE IS NOTHING TO STAGE, rather than an empty frame with a disabled Push
 * under it. The Changes region above already says "nothing since the last push" in that case, and
 * two elements saying the same nothing is one too many.
 */
export function StagingRegion({ view }: { view: GithubView }) {
  const files = view.staging;
  const stageable = useMemo(() => files.filter((f) => !f.locked), [files]);

  // Keyed on the agent AND on the shape of what is stageable, so a new version arriving resets the
  // selection rather than leaving ticks pointing at hunks that have since been renumbered. That is
  // the same reasoning the module header gives for not persisting it, applied within one session.
  const shape = useMemo(
    () => stageable.map((f) => `${f.path}:${f.hunks.length}`).join("|"),
    [stageable],
  );
  const [selected, setSelected] = useState<Set<HunkKey>>(() => everything(files));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  useEffect(() => {
    setSelected(everything(files));
    // Deliberately keyed on the SHAPE rather than on `files`, which is a fresh array on every
    // snapshot — including the ones a stage event triggers during a push in another tab. Resetting
    // on those would untick somebody's work mid-decision.
  }, [view.agentId, shape]);

  if (stageable.length === 0) return null;

  const total = [...selected].length;
  const all = everything(files);
  const whole = total === all.size;

  const toggleFile = (file: GithubStagedFile): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const keys = file.hunks.length === 0
        ? [keyOf(file.path, -1)]
        : file.hunks.map((h) => keyOf(file.path, h.index));
      const anyOff = keys.some((k) => !next.has(k));
      for (const k of keys) {
        if (anyOff) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  const toggleHunk = (path: string, index: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(path, index);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const push = (): void => {
    const stage = stageable
      .map((file) => ({
        path: file.path,
        hunks: file.hunks.filter((h) => selected.has(keyOf(file.path, h.index))).map((h) => h.index),
      }))
      // A file with nothing ticked is omitted rather than sent with an empty list. `stagedTree`
      // treats an empty list as "reconstruct the pushed content", which is the same outcome — but
      // saying it by omission means the request describes what the user chose rather than a
      // reconstruction that happens to equal it.
      .filter((s) => s.hunks.length > 0 || files.find((f) => f.path === s.path)?.hunks.length === 0)
      .filter((s) => s.hunks.length > 0 || selected.has(keyOf(s.path, -1)));

    sendPushGithub(view.agentId, {
      stage,
      ...(message.trim() ? { message } : {}),
    });
  };

  return (
    <section className="mt-3 border-t border-hair pt-3">
      <RegionLabel>
        Staged
        <span className="ml-2 font-normal normal-case tracking-normal text-faint">
          {total} of {all.size}
        </span>
      </RegionLabel>

      <div className="mt-1.5 space-y-1">
        {stageable.map((file) => (
          <StagedFileRow
            key={file.path}
            file={file}
            selected={selected}
            open={expanded.has(file.path)}
            onToggleFile={() => toggleFile(file)}
            onToggleHunk={(index) => toggleHunk(file.path, index)}
            onToggleOpen={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                return next;
              })
            }
          />
        ))}
      </div>

      {/* §B.4.2, said where the consequence lands rather than in a tooltip somewhere else. A partial
          selection does not correspond to a version, so the commit it writes gets no filled dot in
          HISTORY — which is §3.4's existing answer for a hand-staged subset and is worth stating
          before somebody presses the button, not after they notice the dot is hollow. */}
      {!whole && (
        <p className="mt-2 text-[11px] leading-[1.5] text-muted">
          This is a hand-staged subset, so it does not map onto one version: it lands as a single
          commit with no version dot in History, and your versions stay exactly where they are.
        </p>
      )}

      {!whole && (
        <textarea
          className="mt-2 h-16 w-full resize-none rounded-control bg-panel px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-ink outline-none placeholder:text-faint"
          placeholder="What does this subset do? (a staged subset has no version instruction to borrow)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      )}

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-faint">
          {total === 0 ? "nothing staged" : whole ? "everything staged" : `${total} hunk${total === 1 ? "" : "s"}`}
        </span>
        <button
          className={`${primaryBtn} ml-auto`}
          disabled={total === 0 || whole}
          // Disabled when the selection is everything, deliberately: that IS the ordinary push, and
          // the Push button in the sync region above already does it — with the version mapping, the
          // per-version commits and the filled dots this path gives up. Two buttons that both push
          // everything, one of which quietly discards the lineage, is the shape of trap this panel
          // exists not to set.
          title={whole ? "Everything is staged — use Push above, which keeps one commit per version" : undefined}
          onClick={push}
        >
          Commit staged
        </button>
      </div>
    </section>
  );
}

function StagedFileRow({
  file, selected, open, onToggleFile, onToggleHunk, onToggleOpen,
}: {
  file: GithubStagedFile;
  selected: Set<HunkKey>;
  open: boolean;
  onToggleFile: () => void;
  onToggleHunk: (index: number) => void;
  onToggleOpen: () => void;
}) {
  // The three server statuses are already the vocabulary `fileStatusFor` speaks, so the row's glyph
  // and its colour come from the same table every other file row in the app reads.
  const descriptor = fileStatusFor(file.status);
  const TypeIcon = iconForPath(file.path);
  const keys = file.hunks.length === 0
    ? [keyOf(file.path, -1)]
    : file.hunks.map((h) => keyOf(file.path, h.index));
  const on = keys.filter((k) => selected.has(k)).length;
  // THREE STATES, NOT TWO. A file with some hunks ticked is not "off", and drawing it as one would
  // make the file checkbox lie about what the push contains. Same rule §A.5 states for the count
  // slot: an absent answer and a zero are different claims.
  const state: "on" | "off" | "partial" = on === 0 ? "off" : on === keys.length ? "on" : "partial";

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px]">
        <Checkbox
          checked={state === "partial" ? "mixed" : state === "on"}
          onChange={onToggleFile}
          label={`stage ${file.path}`}
        />
        <span
          className="inline-flex w-3 shrink-0 items-center justify-center"
          style={{ color: descriptor.accent }}
          role="img"
          aria-label={descriptor.label}
        >
          <descriptor.Icon size={ICON.xs} />
        </span>
        <span className="inline-flex w-3 shrink-0 items-center justify-center text-faint" aria-hidden>
          <TypeIcon size={ICON.xs} />
        </span>
        <Truncate variant="path" className="min-w-0 flex-1 font-mono text-ink">{file.path}</Truncate>
        <DiffStat additions={file.additions} deletions={file.deletions} className="shrink-0" />
        {file.hunks.length > 1 && (
          <button
            className={quietBtn}
            aria-expanded={open}
            aria-label={open ? "hide hunks" : "show hunks"}
            onClick={onToggleOpen}
          >
            <span className={`inline-block transition-transform duration-fast ${open ? "" : "-rotate-90"}`}>
              <ChevronDownIcon size={ICON.xs} />
            </span>
          </button>
        )}
      </div>

      {/* A deletion has no hunks and says so, rather than offering a checkbox that would mean half
          of a file existing. That is what git's own `add -p` decides about one too. */}
      {file.status === "deleted" && (
        <p className="ml-5 mt-0.5 text-[11px] text-faint">removed — all or nothing, there is no half of this</p>
      )}

      {open && file.hunks.length > 1 && (
        <div className="ml-5 mt-1 space-y-1">
          {file.hunks.map((hunk) => (
            <HunkRow
              key={hunk.index}
              hunk={hunk}
              checked={selected.has(keyOf(file.path, hunk.index))}
              onToggle={() => onToggleHunk(hunk.index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HunkRow({
  hunk, checked, onToggle,
}: {
  hunk: GithubHunkRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-control border border-hair">
      <div className="flex items-center gap-2 px-1.5 py-1 text-[11px]">
        <Checkbox checked={checked} onChange={onToggle} label={`stage ${hunk.header}`} />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <Truncate className="font-mono text-faint" title={hunk.header}>{hunk.header}</Truncate>
        </button>
        <DiffStat additions={hunk.additions} deletions={hunk.deletions} className="shrink-0" />
      </div>
      {open && (
        <pre className="overflow-x-auto border-t border-hair px-1.5 py-1 font-mono text-[10px] leading-[1.5]">
          {hunk.lines.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+") ? "text-ok" : line.startsWith("-") ? "text-err" : "text-faint"
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/**
 * §B.4.4's UNPUSHED list, reorderable.
 *
 * DRAG WITH THE HTML5 API RATHER THAN A LIBRARY, for the reason this codebase has no router and no
 * HTTP framework: this is a vertical list of five rows, and a dependency in the path of a panel
 * render to reorder it would be a dependency kept current forever to save forty lines.
 *
 * THE ORDER LIVES HERE UNTIL SOMEBODY PUSHES, and nothing is written until then. That is not a
 * shortcut — it is what makes the whole feature safe to try: rearranging rows changes which commits
 * the next push writes, and closing the tab leaves every `agent_versions` row exactly where it was.
 *
 * SQUASH AND DROP ARE THE SAME MECHANISM, which is why they are two entries on one menu rather than
 * two features: a squash merges a row into the one below it and a drop removes it, and both are
 * edits to the same step list the drag reorders.
 */
export function RestackRegion({ view }: { view: GithubView }) {
  const refusal = useGithubStore((s) => s.restackRefusals[view.agentId]);
  const clearRestack = useGithubStore((s) => s.clearRestackRefusal);

  // Steps, newest first, matching the list above. Rebuilt whenever the unpushed set changes, for
  // the same reason the staging selection is: an order over versions that have since been pushed is
  // an order over rows that are no longer there.
  const shape = view.stack.map((s) => s.versionId).join("|");
  const [steps, setSteps] = useState<string[][]>(() => view.stack.map((s) => [s.versionId]));
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => {
    setSteps(view.stack.map((s) => [s.versionId]));
    clearRestack(view.agentId);
  }, [view.agentId, shape, clearRestack]);

  const summaries = new Map(view.stack.map((s) => [s.versionId, s]));
  const dirty = steps.length !== view.stack.length || steps.some((s, i) => s[0] !== view.stack[i]?.versionId || s.length > 1);

  if (view.stack.length < 2) {
    // One unpushed version has no order to have. §B.4.3's amend is still available on it, and lives
    // where an amend belongs — in the commit box — rather than in a reorder list of one row.
    return null;
  }

  const move = (from: number, to: number): void => {
    setSteps((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [row] = next.splice(from, 1);
      if (row) next.splice(to, 0, row);
      return next;
    });
    clearRestack(view.agentId);
  };

  const squashInto = (index: number): void => {
    // Into the row BELOW, which in a newest-first list is the OLDER version — so a squash reads as
    // "fold this into the thing it was building on", which is the direction git's own interactive
    // rebase squashes in.
    setSteps((prev) => {
      if (index + 1 >= prev.length) return prev;
      const next = [...prev];
      const above = next[index] ?? [];
      const below = next[index + 1] ?? [];
      // Members are ordered OLDEST FIRST inside a step, because `replay` applies them in order and
      // the server anchors the commit on the last one.
      next.splice(index, 2, [...below, ...above]);
      return next;
    });
    clearRestack(view.agentId);
  };

  const drop = (index: number): void => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    clearRestack(view.agentId);
  };

  const push = (): void => {
    // Reversed on the way out: the panel renders newest first and a history is written oldest first.
    sendPushGithub(view.agentId, { steps: [...steps].reverse().map((versionIds) => ({ versionIds })) });
  };

  return (
    <section className="mt-4">
      <RegionLabel>
        Reorder
        <span className="ml-2 font-normal normal-case tracking-normal text-faint">{steps.length}</span>
      </RegionLabel>

      <div className="mt-1.5 space-y-0.5">
        {steps.map((versionIds, index) => {
          const head = summaries.get(versionIds[versionIds.length - 1] ?? "");
          const failed = refusal ? refusal.position === steps.length - 1 - index : false;
          return (
            <div
              key={versionIds.join("+")}
              draggable
              onDragStart={() => setDragging(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              className={`flex items-center gap-2 rounded-control px-1 py-1 text-[11px] ${
                failed ? "border border-err/40 bg-err/5" : "border border-transparent"
              } ${dragging === index ? "opacity-50" : ""}`}
            >
              <span className="shrink-0 cursor-grab text-faint" aria-hidden>≡</span>
              <span className="w-8 shrink-0 text-right font-mono text-faint">
                v{head?.version ?? "?"}
              </span>
              <Truncate className="min-w-0 flex-1 text-ink" title={head?.summary}>
                {head?.summary ?? "…"}
              </Truncate>
              {versionIds.length > 1 && (
                <Chip size="sm" tone="faint" caps title={`${versionIds.length} versions in one commit`}>
                  squashed {versionIds.length}
                </Chip>
              )}
              <button
                className={quietBtn}
                disabled={index + 1 >= steps.length}
                title="Fold this into the commit below it"
                onClick={() => squashInto(index)}
              >
                squash
              </button>
              <button className={`${quietBtn} !text-err`} title="Leave this version out of the push" onClick={() => drop(index)}>
                drop
              </button>
            </div>
          );
        })}
      </div>

      {/* §B.4.4's refusal, where the row is, rather than in the error strip at the top of the panel.
          The validator's own words are the useful half — "the project fails to import: no module
          named tools.helper" tells somebody exactly which move to undo. */}
      {refusal && (
        <div className="mt-2 rounded-control border border-err/30 px-2 py-1.5">
          <p className="text-[11px] leading-[1.5] text-err">{refusal.message}</p>
          {refusal.problems.slice(0, 3).map((p, i) => (
            <p key={i} className="mt-0.5 font-mono text-[10px] leading-[1.5] text-muted">{p}</p>
          ))}
          <p className="mt-1 text-[11px] leading-[1.5] text-faint">
            Nothing was written. Your versions are exactly where they were.
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-faint">
          drag to reorder · squash folds into the row below · nothing is written until you push
        </span>
        <button
          className={`${primaryBtn} ml-auto`}
          disabled={!dirty || steps.length === 0}
          onClick={push}
        >
          Push in this order
        </button>
      </div>
    </section>
  );
}

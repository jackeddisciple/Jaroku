// Bringing GitHub context into the conversation — §7.
//
// The question this exists for is a real one: "why did someone remove the retry logic". Answering
// it means the assistant has the actual diff rather than a description of it, and until now the
// only place that diff existed was a panel the composer could not reach.
//
// WHAT IS ATTACHED IS A REFERENCE, NEVER CONTENT. The chip holds an identifier and the server
// resolves it when the message is sent. That is not an optimisation: an attachment made five
// minutes ago should ground the answer in the repository AS IT IS, and a client that captured the
// diff at click time would quietly ground it in a stale one.
//
// AND NOTHING HERE TRIGGERS A PUSH OR A PULL. The ⊕ menu is for bringing context IN; it is never a
// shortcut for taking a git action. Push, pull, commit and force-override all live in the panel
// precisely because they are deliberate, confirmed actions — commit messages, divergence warnings,
// the audit-logged force flow. Blurring that line, letting a casual "attach" turn into a write,
// would undercut the same trust guarantee the PROTECTED-files design exists to protect. The
// enforcement is structural rather than a rule somebody remembers: every entry below produces a
// `GithubAttachment`, and there is no code path from one of those to a mutation.
//
// WHICH ENTRIES EXIST DEPENDS ON WHAT IS TRUE, not on what is implemented. An agent with no link
// has no menu at all; the sync-state entries appear only when there is a delta to describe; the PR
// entry appears only when a PR exists. Absent rather than shown-and-disabled, because a greyed
// "Open PR (#42)" for an agent with no PR is a promise about a number that does not exist.

import { useEffect, useRef, useState } from "react";

import { ICON } from "../lib/tokens.ts";
import { useGithubStore } from "../store/githubStore.ts";
import type { GithubAttachment, GithubView } from "../types.ts";
import type { ActiveTrigger, TriggerKind } from "../lib/composerTriggers.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { ChevronRightIcon, GithubIcon, PlusIcon, XIcon } from "./panelIcons.tsx";
import { Select } from "./Select.tsx";

/** A stable identity for an attachment, so the same thing cannot be attached twice. */
export function attachmentId(a: GithubAttachment): string {
  switch (a.kind) {
    case "commit": return `commit:${a.sha}`;
    case "file": return `file:${a.ref}:${a.path}`;
    // §B.5.1's chip. Identified by the comment it quotes, so attaching two different comments is
    // two chips and attaching the same one twice is one — which matters because Fix in Jaroku is a
    // button somebody can press again while the first edit is still on screen.
    case "reviewComment": return `reviewComment:${a.commentId}`;
    default: return a.kind;
  }
}

/** How a chip reads. Short, because it sits in a row above something somebody is typing into. */
export function attachmentLabel(a: GithubAttachment): string {
  switch (a.kind) {
    case "unpushed": return "diff of unpushed versions";
    case "commit": return a.sha.slice(0, 7);
    case "file": return `${a.path} @ ${a.ref}`;
    case "sinceSync": return "diff since last sync";
    case "pr": return "open PR";
    // The id and not the body, because a chip sits in one line above something somebody is typing
    // into — and a reviewer's sentence is the wrong length for that. The body is in the attachment
    // the server resolves, which is where the model reads it.
    case "reviewComment": return `review comment #${a.commentId.slice(0, 8)}`;
  }
}

/**
 * The ⊕ menu's GitHub submenu.
 *
 * Renders nothing when the agent is unlinked — see the header. The entries are exactly §7's, and
 * the phase split falls out of the data rather than out of a feature flag: "diff since last sync"
 * needs a delta to exist, and a PR entry needs a PR.
 */
export function GitHubAttachMenu({
  view,
  onAttach,
}: {
  view: GithubView | null;
  onAttach: (attachment: GithubAttachment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!view) return null;

  const take = (attachment: GithubAttachment): void => {
    onAttach(attachment);
    setOpen(false);
    setPickingFile(false);
  };

  const hasDelta = view.state === "ahead" || view.state === "behind" || view.state === "diverged";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Attach GitHub context"
        className={`transition-colors ${open ? "text-ink" : "text-muted hover:text-ink"}`}
      >
        <span className="inline-flex items-center gap-1">
          <PlusIcon size={ICON.sm} />
          <GithubIcon size={12} />
        </span>
      </button>

      {open && (
        // Opens UPWARD, like the model selector beside it: the composer is at the bottom of the
        // column and a menu opening down would be a menu off the screen.
        <div className="absolute bottom-full left-0 z-30 mb-2 min-w-[260px] rounded-card border border-edge bg-panel p-1 shadow-floating">
          <div className="px-2 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-faint">
            Attach from {view.link.repo_full_name}
          </div>

          <MenuItem
            label="Diff of unpushed versions"
            detail={
              view.unpushed.length === 0
                ? "nothing unpushed"
                : `${view.unpushed.length} version${view.unpushed.length === 1 ? "" : "s"}`
            }
            disabled={view.unpushed.length === 0}
            onSelect={() => take({ kind: "unpushed" })}
          />

          {/* Phase 2's entries, present only when the sync state they describe exists. */}
          {hasDelta && (
            <MenuItem
              label="Diff since last sync"
              detail="what changed on GitHub since Jaroku last looked"
              onSelect={() => take({ kind: "sinceSync" })}
            />
          )}

          <MenuItem
            label="A specific commit…"
            detail={`${view.pushed.filter((v) => v.sha).length + view.remoteOnly.length} on this branch`}
            expand
            onSelect={() => setPickingFile(false)}
          >
            <CommitList view={view} onPick={(sha) => take({ kind: "commit", sha })} />
          </MenuItem>

          <MenuItem
            label="A specific file at a ref…"
            detail={pickingFile ? undefined : "any path, on any branch"}
            expand
            onSelect={() => setPickingFile((v) => !v)}
          >
            <FilePicker view={view} onPick={(path, refName) => take({ kind: "file", path, ref: refName })} />
          </MenuItem>

          {view.pr && (
            <MenuItem
              label={`Open PR (#${view.pr.number})`}
              detail={view.pr.title}
              onSelect={() => take({ kind: "pr" })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label, detail, onSelect, disabled = false, expand = false, children,
}: {
  label: string;
  detail?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Reveals `children` in place rather than acting. For the two entries that need a picker. */
  expand?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (expand) setOpen((v) => !v);
          onSelect();
        }}
        className="flex w-full items-start gap-2 rounded-control px-2 py-1 text-left transition-colors duration-fast hover:bg-active/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] text-ink">{label}</span>
          {detail && <span className="block text-[10px] text-faint">{detail}</span>}
        </span>
        {expand && (
          <span className={`shrink-0 text-faint transition-transform duration-fast ${open ? "rotate-90" : ""}`} aria-hidden>
            <ChevronRightIcon size={ICON.xs} />
          </span>
        )}
      </button>
      {expand && open && <div className="mb-1 ml-2 border-l border-hair pl-2">{children}</div>}
    </div>
  );
}

/** Every commit on the branch, ours and theirs, newest first. */
function CommitList({ view, onPick }: { view: GithubView; onPick: (sha: string) => void }) {
  const rows = [
    ...view.pushed.filter((v) => v.sha).map((v) => ({ sha: v.sha!, message: v.summary })),
    ...view.remoteOnly.map((c) => ({ sha: c.sha, message: c.message })),
  ];
  if (rows.length === 0) return <p className="px-1 py-1 text-[11px] text-muted">nothing pushed yet</p>;
  return (
    <div className="max-h-40 overflow-auto">
      {rows.map((r) => (
        <button
          key={r.sha}
          type="button"
          onClick={() => onPick(r.sha)}
          className="flex w-full items-baseline gap-2 rounded-control px-1 py-0.5 text-left transition-colors duration-fast hover:bg-active/40"
        >
          <span className="shrink-0 font-mono text-[10px] text-faint">{r.sha.slice(0, 7)}</span>
          <Truncate className="min-w-0 flex-1 text-[11px] text-muted">{r.message}</Truncate>
        </button>
      ))}
    </div>
  );
}

/** A path, and the ref to read it at. Free text, because the repository may hold files Jaroku
 *  has never published — which is exactly the case somebody attaches one to ask about. */
function FilePicker({ view, onPick }: { view: GithubView; onPick: (path: string, ref: string) => void }) {
  const [path, setPath] = useState("");
  const [refName, setRefName] = useState(view.link.branch);
  return (
    <div className="space-y-1 py-1">
      <input
        className="w-full rounded-control bg-bg px-1.5 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
        placeholder="tools/weather.py"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && path.trim()) onPick(path.trim(), refName);
        }}
      />
      <Select
        mono
        value={refName}
        onChange={setRefName}
        ariaLabel="Branch"
        options={view.branches.map((b) => ({ value: b.name, label: b.name }))}
      />
    </div>
  );
}

/**
 * The attached chips, above the composer.
 *
 * The same visual system as every other chip in the app — this is a reference to a thing, which is
 * what a chip is for — with a remove control, because an attachment somebody cannot take off is an
 * attachment they have to clear by sending the message.
 */
export function GitHubAttachChips({
  attachments,
  onRemove,
}: {
  attachments: GithubAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1">
      {attachments.map((a) => (
        <Chip
          key={attachmentId(a)}
          size="sm"
          tone="muted"
          mono
          icon={<GithubIcon size={ICON.badge} />}
          className="max-w-[240px]"
        >
          <Truncate variant={a.kind === "file" ? "path" : "prose"} className="min-w-0">
            {attachmentLabel(a)}
          </Truncate>
          <button
            type="button"
            className="shrink-0 text-faint hover:text-ink"
            onClick={() => onRemove(attachmentId(a))}
            aria-label={`Remove ${attachmentLabel(a)}`}
          >
            <XIcon size={ICON.badge} />
          </button>
        </Chip>
      ))}
    </div>
  );
}


/**
 * The picker a trigger character opens — §A.6.
 *
 * THE SAME ATTACH ACTION THE ⊕ MENU PERFORMS, reached faster. Not a second surface with its own
 * rules: it produces the same `GithubAttachment` values, the resulting chips are the ⊕ menu's
 * chips, and there is no entry here that the menu does not also offer. The trigger characters are
 * a shortcut to an existing action, never a new one.
 *
 * ANCHORED ABOVE THE COMPOSER rather than at the caret. A caret-tracking popover needs a mirror of
 * the textarea's layout to position against, which is a measurement that goes wrong at every font
 * and wrap boundary — and the composer is one control at the bottom of a column, so "above it" is
 * unambiguous and always on screen.
 */
export function GitHubTriggerPicker({
  view,
  trigger,
  paths,
  onPick,
  onDismiss,
}: {
  view: GithubView;
  trigger: ActiveTrigger;
  /** Every path the agent has, from the loaded project. See `triggerRows`. */
  paths: string[];
  onPick: (attachment: GithubAttachment) => void;
  onDismiss: () => void;
}) {
  const rows = triggerRows(view, trigger, paths);
  const [cursor, setCursor] = useState(0);

  // The query changes on every keystroke and the list changes under it, so the highlight goes back
  // to the top rather than staying on an index that now points at a different row.
  useEffect(() => {
    setCursor(0);
  }, [trigger.kind, trigger.query]);

  // THE PICKER IS DRIVEN WITHOUT LEAVING THE TEXTAREA — that is the entire point of a trigger
  // character over the menu. Captured at the document so the keys work while the caret is still in
  // the input, and `preventDefault` so Enter selects a row rather than sending the half-written
  // message underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c - 1 + rows.length) % rows.length);
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const row = rows[cursor];
        if (row) onPick(row.attachment);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [rows, cursor, onPick, onDismiss]);

  if (rows.length === 0) return null;

  return (
    <div className="mb-2 max-h-44 overflow-auto rounded-card border border-edge bg-panel p-1 shadow-floating">
      {/* `!` HAS NO FILTER AND ONE ENTRY, so Enter attaches it immediately. The row exists so a
          mistyped `!` is one Escape away rather than an attachment somebody has to notice and
          remove — and the caption says what it does, because a bare `!` is the shortcut most
          likely to be misread as an imperative when it still only attaches context. */}
      {trigger.kind === "sync" && (
        <div className="px-2 pb-1 pt-0.5 text-[10px] leading-[1.4] text-faint">
          Attaches the diff. It does not pull.
        </div>
      )}
      {rows.map((row, i) => (
        <button
          key={row.id}
          type="button"
          // `onMouseDown` rather than `onClick`: a click blurs the textarea first, and a picker
          // that steals focus from the sentence somebody is mid-way through typing is a picker
          // they have to click back out of.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(row.attachment);
          }}
          onMouseEnter={() => setCursor(i)}
          className={`flex w-full items-baseline gap-2 rounded-control px-2 py-1 text-left transition-colors duration-fast ${
            i === cursor ? "bg-active text-ink" : "hover:bg-active/40"
          }`}
        >
          <span className="shrink-0 font-mono text-[11px] text-faint">{row.lead}</span>
          <Truncate
            variant={trigger.kind === "file" ? "path" : "prose"}
            className="min-w-0 flex-1 text-[11px] text-muted"
          >
            {row.label}
          </Truncate>
        </button>
      ))}
    </div>
  );
}

/**
 * What a trigger offers, filtered by what has been typed after it.
 *
 * `#` MATCHES A SHA PREFIX OR MESSAGE TEXT, because people remember one or the other and rarely
 * both — "the retry one" and "a1b2" should find the same commit.
 */
function triggerRows(
  view: GithubView,
  trigger: ActiveTrigger,
  agentPaths: string[],
): { id: string; lead: string; label: string; attachment: GithubAttachment }[] {
  const q = trigger.query.trim().toLowerCase();

  if (trigger.kind === "commit") {
    const commits = [
      ...view.pushed.filter((v) => v.sha).map((v) => ({ sha: v.sha!, message: v.summary })),
      ...view.remoteOnly.map((c) => ({ sha: c.sha, message: c.message })),
    ];
    return commits
      .filter((c) => !q || c.sha.toLowerCase().startsWith(q) || c.message.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => ({
        id: c.sha,
        lead: `#${c.sha.slice(0, 7)}`,
        label: c.message,
        attachment: { kind: "commit", sha: c.sha },
      }));
  }

  if (trigger.kind === "file") {
    // THE AGENT'S OWN FILE LIST FIRST, then anything the repository has that the agent does not.
    // A picker offering only the CHANGED files could not attach `agent.py` — which is the file
    // somebody most often wants to ask about, precisely because it has not changed. The union is
    // the honest offer, and the query narrows it on the first keystroke.
    const paths = [
      ...new Set([
        ...agentPaths,
        ...view.changes.map((c) => c.path),
        ...view.protectedPaths,
        ...view.remoteChanges,
      ]),
    ].sort();
    // THE CURRENT BRANCH FIRST. Asking about a file almost always means the branch in front of
    // you, and ordering by whatever GitHub returned would put `main` at the top and make the
    // common case the one that needs an arrow key.
    const refs =
      view.branches.length > 0
        ? [...view.branches].sort((a, b) => Number(b.current) - Number(a.current)).map((b) => b.name)
        : [view.link.branch];
    const rows: { id: string; lead: string; label: string; attachment: GithubAttachment }[] = [];
    for (const path of paths) {
      if (q && !path.toLowerCase().includes(q)) continue;
      for (const ref of refs) {
        rows.push({
          id: `${ref}:${path}`,
          lead: "@",
          label: `${path} @ ${ref}`,
          attachment: { kind: "file", path, ref },
        });
        if (rows.length >= 8) return rows;
      }
    }
    return rows;
  }

  // `!` has no picker at all — one entry, inserted on the keystroke. It is rendered as a single
  // confirmable row rather than attaching silently, so a mistyped `!` is one Escape away rather
  // than an attachment somebody has to notice and remove.
  return [
    {
      id: "sinceSync",
      lead: "!",
      label: `diff since last sync — ${view.verdict.toLowerCase()}`,
      attachment: { kind: "sinceSync" },
    },
  ];
}

/** The attachments the composer is holding, and the two ways they change. */
export function useGithubAttachments(agentId: string | null): {
  view: GithubView | null;
  attachments: GithubAttachment[];
  /**
   * Which trigger characters are live right now — §A.6.
   *
   * ABSENT RATHER THAN DISABLED. `#` needs only push history, so it works as soon as anything has
   * been pushed. `@` and `!` need real sync-state machinery behind them, and before that they are
   * simply not triggers: typing one types a character, the same way §7 hides its Phase-2 menu
   * entries rather than greying them out.
   */
  triggers: TriggerKind[];
  attach: (a: GithubAttachment) => void;
  remove: (id: string) => void;
  clear: () => void;
} {
  const view = useGithubStore((s) => (agentId ? (s.views[agentId] ?? null) : null));
  const [attachments, setAttachments] = useState<GithubAttachment[]>([]);

  // Switching agents clears them. An attachment is a reference into ONE repository, and carrying
  // it across would send a commit sha from one agent's repo with a question about another's.
  useEffect(() => {
    setAttachments([]);
  }, [agentId]);

  const triggers: TriggerKind[] = [];
  if (view && (view.pushed.some((v) => v.sha) || view.remoteOnly.length > 0)) triggers.push("commit");
  if (view && view.link.last_known_remote_sha) triggers.push("file", "sync");

  return {
    view,
    attachments,
    triggers,
    attach: (a) =>
      setAttachments((prev) =>
        // Idempotent by identity: attaching the same commit twice is one attachment, not a
        // duplicate that doubles the context budget it spends.
        prev.some((p) => attachmentId(p) === attachmentId(a)) ? prev : [...prev, a],
      ),
    remove: (id) => setAttachments((prev) => prev.filter((p) => attachmentId(p) !== id)),
    clear: () => setAttachments([]),
  };
}

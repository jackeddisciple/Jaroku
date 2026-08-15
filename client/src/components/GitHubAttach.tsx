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
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { ChevronRightIcon, GithubIcon, PlusIcon, XIcon } from "./panelIcons.tsx";

/** A stable identity for an attachment, so the same thing cannot be attached twice. */
export function attachmentId(a: GithubAttachment): string {
  switch (a.kind) {
    case "commit": return `commit:${a.sha}`;
    case "file": return `file:${a.ref}:${a.path}`;
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
          <span className={`mt-0.5 shrink-0 text-faint transition-transform duration-fast ${open ? "rotate-90" : ""}`} aria-hidden>
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
      <select
        className="w-full rounded-control bg-bg px-1.5 py-1 font-mono text-[11px] text-ink outline-none"
        value={refName}
        onChange={(e) => setRefName(e.target.value)}
      >
        {view.branches.map((b) => (
          <option key={b.name} value={b.name}>{b.name}</option>
        ))}
      </select>
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
          icon={<GithubIcon size={10} />}
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
            <XIcon size={10} />
          </button>
        </Chip>
      ))}
    </div>
  );
}

/** The attachments the composer is holding, and the two ways they change. */
export function useGithubAttachments(agentId: string | null): {
  view: GithubView | null;
  attachments: GithubAttachment[];
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

  return {
    view,
    attachments,
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

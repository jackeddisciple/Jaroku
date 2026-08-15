// The three regions that give the verdict its context: what changed, which branch, and what
// happened — on both sides.
//
// §3.8's history is the one worth reading the code for. Two lineages, one column: filled dots are
// Jaroku versions, hollow ones are commits no version accounts for, and the ├─○ gutter marker is
// the same indentation vocabulary the sidebar already uses for run branch history. A reader who
// has learned lineage once in this app has learned it here.
//
// §3.3's PROTECTED group is the part a generic git client would get wrong, and the part this file
// exists to get right. Jaroku enforces read-only guarantees on reviewed connectors,
// `tools/__init__.py` and the MCP bridge — the edit loop cannot touch them and the object store's
// block list covers them. A git panel that let you casually stage a hand-edit to `mcp_bridge.py`
// would quietly hand back the exact capability the whole trust model removes. So they are listed,
// visible, greyed, with the reason on hover — and the list comes from the SERVER, because a block
// list computed in the browser is a block list an attacker can edit.

import { useEffect, useRef, useState } from "react";

import {
  sendCreateGithubBranch, sendOpenGithubPr, sendSwitchGithubBranch,
} from "../lib/socket.ts";
import { relTime } from "../lib/format.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import type { GithubView } from "../types.ts";
import { fileStatusFor, type FileStatus } from "../lib/actionIcons.tsx";
import { iconForPath } from "./fileIcons.tsx";
import { RegionLabel } from "./GitHubSync.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import {
  CheckIcon, ChevronDownIcon, ExternalLinkIcon, GitPullRequestIcon, SearchIcon, XIcon,
} from "./panelIcons.tsx";

// --- §3.2 the branch switcher -----------------------------------------------

/**
 * Switching a LINKED branch is heavier than switching in an editor.
 *
 * Jaroku's working state is the agent's current published version, so switching means
 * re-materialising the agent from a different branch's tree. With unpushed work the switcher
 * therefore asks explicitly and offers three answers — push first, keep them as a draft, or
 * cancel — and never a silent overwrite. The server refuses anything else, so this dialog is the
 * honest front of a real rule rather than a courtesy.
 */
export function BranchSwitcher({ view }: { view: GithubView }) {
  const [open, setOpen] = useState(false);
  // §A.7's chip opens the tab AT this control rather than merely at the panel. A nonce rather than
  // a boolean, so clicking the chip twice re-opens the switcher rather than firing once and then
  // being permanently satisfied.
  const branchNonce = useUiStore((s) => s.githubBranchNonce);
  const firstNonce = useRef(branchNonce);
  useEffect(() => {
    if (branchNonce !== firstNonce.current) setOpen(true);
  }, [branchNonce]);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState("");
  const [pending, setPending] = useState<string | null>(null);
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

  const q = filter.trim().toLowerCase();
  const branches = q ? view.branches.filter((b) => b.name.toLowerCase().includes(q)) : view.branches;

  const choose = (name: string): void => {
    if (name === view.link.branch) return setOpen(false);
    // The confirmation is only asked when it can matter. Interrupting a switch with a dialog about
    // work that does not exist is the kind of prompt people learn to click through.
    if (view.ahead > 0) setPending(name);
    else {
      sendSwitchGithubBranch(view.agentId, name);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center gap-1 font-mono text-[11px] text-muted transition-colors duration-fast hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        <Truncate title={view.link.branch}>{view.link.branch}</Truncate>
        <span className={`shrink-0 transition-transform duration-fast ${open ? "rotate-180" : ""}`} aria-hidden>
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[280px] rounded-card border border-edge bg-panel p-1 shadow-floating">
          <div className="flex items-center gap-1.5 border-b border-hair px-2 py-1.5">
            <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-faint"
              placeholder="Filter branches…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          <div className="max-h-56 overflow-auto py-1">
            {branches.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-muted">nothing matches</p>
            ) : (
              branches.map((b) => (
                <button
                  key={b.name}
                  onClick={() => choose(b.name)}
                  className={`flex w-full items-start gap-2 rounded-control px-2 py-1 text-left transition-colors duration-fast ${
                    b.current ? "bg-active text-ink" : "text-muted hover:bg-active/40 hover:text-ink"
                  }`}
                >
                  <span className="inline-flex w-[11px] shrink-0 items-center justify-center pt-[2px]" aria-hidden>
                    {b.current && <CheckIcon size={ICON.xs} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Truncate className="font-mono text-[11px]" title={b.name}>{b.name}</Truncate>
                    {b.isDefault && (
                      // Named rather than hidden. Jaroku never writes to it on its own, and knowing
                      // which one that is before switching is the point of the label.
                      <span className="block text-[10px] text-faint">default — Jaroku does not push here</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-hair p-1">
            <div className="flex items-center gap-1.5">
              <input
                className="min-w-0 flex-1 rounded-control bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
                placeholder="+ Create branch from current…"
                value={creating}
                onChange={(e) => setCreating(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && creating.trim()) {
                    sendCreateGithubBranch(view.agentId, creating.trim());
                    setCreating("");
                    setOpen(false);
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[300px] rounded-card border border-edge bg-panel p-2.5 shadow-floating">
          <div className="text-[12px] text-ink">
            {view.ahead} unpushed version{view.ahead === 1 ? "" : "s"}
          </div>
          <p className="mt-1 text-[11px] leading-[1.5] text-muted">
            Switching re-materialises this agent from{" "}
            <span className="font-mono text-ink">{pending}</span>. Your unpushed work is not lost
            either way — but it is not on that branch.
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              className={primaryBtn}
              onClick={() => {
                sendSwitchGithubBranch(view.agentId, pending, "push");
                setPending(null);
                setOpen(false);
              }}
            >
              Push first
            </button>
            <button
              className={secondaryBtn}
              title="Keeps them as versions here and switches anyway."
              onClick={() => {
                sendSwitchGithubBranch(view.agentId, pending, "stash");
                setPending(null);
                setOpen(false);
              }}
            >
              Keep as a draft
            </button>
            <button className={`${quietBtn} ml-auto`} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- §3.3 the changes region ------------------------------------------------

/**
 * What the unpushed versions touched, and what may never be touched here.
 *
 * NO STAGE / UNSTAGE CHECKBOXES, and their absence is a design decision rather than a gap. Jaroku
 * has no working tree: an agent's files are immutable per version, so there is no half-committed
 * state a checkbox could describe. What the region genuinely answers is "what is in the push I am
 * about to make", and the honest control for that is the push button above it.
 */
export function ChangesRegion({ view }: { view: GithubView }) {
  const changed = view.changes.filter((c) => !c.locked);
  const locked = view.changes.filter((c) => c.locked);
  // Protected files that were NOT touched are still worth listing — the group's job is to say what
  // this surface cannot do, and it can only do that when the files are visible.
  const untouched = view.protectedPaths.filter((p) => !view.changes.some((c) => c.path === p));
  const remote = view.remoteChanges;

  if (changed.length === 0 && locked.length === 0 && untouched.length === 0 && remote.length === 0) {
    return null;
  }

  return (
    // No heading of its own: §A.5's CollapsibleRegion above owns the label, the count and the
    // chevron for all four regions, so that they line up as one column of click targets.
    <section>
      <div className="space-y-0.5">
        {changed.map((c) => (
          <FileRow
            key={c.path}
            path={c.path}
            status={c.status === "added" ? "added" : "modified"}
            trailing={<DiffStat additions={c.additions} deletions={c.deletions} className="shrink-0" />}
          />
        ))}
        {changed.length === 0 && <p className="text-[11px] text-muted">nothing since the last push</p>}
      </div>

      {/* §A.4's FROM REMOTE group. Its own heading rather than mixed into the list above, because
          these files have NOT been through Jaroku's validator — that is what a pull is for — and a
          row that read the same as a local change would be claiming otherwise. */}
      {remote.length > 0 && (
        <FileGroup label={`From remote (${remote.length}) — pending pull`}>
          {remote.map((path) => <FileRow key={path} path={path} status="remote" />)}
        </FileGroup>
      )}

      {(locked.length > 0 || untouched.length > 0) && (
        <FileGroup label="Protected (not editable here)">
          {[...locked.map((l) => l.path), ...untouched].map((path) => (
            <FileRow key={path} path={path} status="protected" muted />
          ))}
        </FileGroup>
      )}
    </section>
  );
}

function FileGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * One file: what happened to it, what it is, and what it cost.
 *
 * TWO ICON COLUMNS, and §A.4 is the argument for the split. The leading glyph is the STATUS — what
 * happened — and the trailing one is the FILE TYPE — what it is. One slot doing both meant a fresh
 * file and a modified one read identically unless you had already looked up at the section header,
 * which is an extra lookup that gets more expensive the longer the list gets.
 *
 * They share a stroke weight and a size deliberately: this is one icon system on two semantic axes,
 * not two icon systems sitting next to each other.
 */
function FileRow({
  path, status, trailing, muted = false,
}: {
  path: string;
  status: FileStatus;
  trailing?: React.ReactNode;
  muted?: boolean;
}) {
  const descriptor = fileStatusFor(status);
  const TypeIcon = iconForPath(path);
  return (
    <div className="flex items-center gap-2 text-[11px]" title={descriptor.label}>
      {/* Fixed width, so the filenames line up as a column whatever glyph precedes them. A status
          column whose width changed per row would be worse than no column at all. */}
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
      {/* §A.3: the filename and its extension are what identify the row, so the middle gives way. */}
      <Truncate variant="path" className={`min-w-0 flex-1 font-mono ${muted ? "text-faint" : "text-ink"}`}>
        {path}
      </Truncate>
      {trailing}
    </div>
  );
}

// --- §3.9 the pull request --------------------------------------------------

/**
 * The open PR, or the button that opens one.
 *
 * CI STATUS MATTERS HERE SPECIFICALLY because Jaroku emits a deploy-ready project — a repo with a
 * Dockerfile can run real build checks, so the PR is a genuine gate rather than decoration. Which
 * is exactly why `checks === null` renders as "no checks", never as a tick: the fastest way to turn
 * a gate back into decoration is to draw "nothing reported" in green.
 */
export function PullRequestCard({ view }: { view: GithubView }) {
  if (!view.pr) {
    // Only offered where §3.1's model says a PR is the move: Jaroku's own branch, with something
    // on it. Reconciliation is always through a PR and never a silent auto-merge.
    if (view.state !== "diverged" && view.pushed.length === 0) return null;
    return (
      <section>
        <RegionLabel>Pull request</RegionLabel>
        <div className="mt-1.5 flex items-center gap-2">
          <button className={secondaryBtn} onClick={() => sendOpenGithubPr(view.agentId)}>
            <GitPullRequestIcon size={ICON.xs} /> Open PR to resolve
          </button>
          <span className="text-[11px] text-faint">
            Resolving on GitHub keeps both histories.
          </span>
        </div>
      </section>
    );
  }

  const pr = view.pr;
  const checkTone = pr.checks === "success" ? "text-ok" : pr.checks === "failure" ? "text-err" : "text-muted";
  return (
    <section>
      <RegionLabel>Pull request</RegionLabel>
      <div className="mt-1.5 rounded-card border border-hair p-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-[2px] shrink-0 text-muted"><GitPullRequestIcon size={ICON.xs} /></span>
          <span className="min-w-0 flex-1">
            <Truncate className="text-[12px] text-ink" title={pr.title}>#{pr.number} {pr.title}</Truncate>
            <span className="mt-0.5 block font-mono text-[11px] text-faint">
              {view.link.branch} → {view.branches.find((b) => b.isDefault)?.name ?? "main"}
            </span>
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={checkTone}>
            {pr.checks === "success"
              ? "✓ checks passing"
              : pr.checks === "failure"
                ? "checks failing"
                : pr.checks === "pending"
                  ? "checks running"
                  : "no checks reported"}
          </span>
          <span className="text-faint">·</span>
          <span className="tabular-nums text-muted">
            {pr.commits} commit{pr.commits === 1 ? "" : "s"} · {pr.files} file{pr.files === 1 ? "" : "s"}
          </span>
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
          <a
            className={`${secondaryBtn} ml-auto`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            View on GitHub <ExternalLinkIcon size={ICON.xs} />
          </a>
        </div>
      </div>
    </section>
  );
}

// --- §3.8 history, two lineages, one view -----------------------------------

/**
 * Filled dots are Jaroku versions; hollow are GitHub-only commits.
 *
 * INTERLEAVED BY TIME, which is the only ordering that makes the two lineages comparable — sorting
 * them into two blocks would answer "what did each side do" and never "what happened, in what
 * order", which is the question somebody arrives at a diverged repository with.
 */
export function HistoryRegion({ view }: { view: GithubView }) {
  const [mode, setMode] = useState<"versions" | "both">("both");

  type Row =
    | { kind: "version"; at: string; id: string; version: number; summary: string; sha: string | null; url: string | null }
    | { kind: "commit"; at: string; id: string; message: string; author: string | null; sha: string; url: string };

  const versionRows: Row[] = [...view.unpushed, ...view.pushed].map((v) => ({
    kind: "version",
    at: v.createdAt,
    id: v.id,
    version: v.version,
    summary: v.summary,
    sha: v.sha,
    url: v.shaUrl,
  }));
  const commitRows: Row[] =
    mode === "both"
      ? view.remoteOnly.map((c) => ({
          kind: "commit",
          at: c.at,
          id: c.sha,
          message: c.message,
          author: c.author,
          sha: c.sha,
          url: c.url,
        }))
      : [];

  const rows = [...versionRows, ...commitRows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (rows.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-end gap-1">
        {(["versions", "both"] as const).map((m) => (
          <Chip key={m} size="sm" selected={mode === m} onClick={() => setMode(m)}>
            {m === "versions" ? "Versions" : "Both"}
          </Chip>
        ))}
      </div>

      <div className="relative mt-1.5">
        {/* The rail. The same shape the trace timeline and the deploy stages use, because a
            sequence reads as one thing when it is drawn on one line. */}
        <div className="absolute bottom-2 left-[5px] top-2 w-px bg-hair" />
        {rows.map((row) =>
          row.kind === "version" ? (
            <div key={row.id} className="relative flex items-start gap-2 py-1 pl-0">
              {/* Filled: this is ours. */}
              <span className="z-10 mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-ink" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-faint">v{row.version}</span>
                  <Truncate className="min-w-0 flex-1 text-[12px] text-ink" title={row.summary}>
                    {row.summary}
                  </Truncate>
                  <span className="shrink-0 text-[11px] text-faint">{relTime(row.at)}</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {row.sha && row.url ? (
                    <a href={row.url} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                      {row.sha.slice(0, 7)} · pushed
                    </a>
                  ) : (
                    // Said plainly. "Local only" is the most useful thing a history row can tell
                    // somebody staring at a badge that says ↑2.
                    <span className="text-faint">local only — never pushed</span>
                  )}
                </span>
              </span>
            </div>
          ) : (
            <div key={row.id} className="relative flex items-start gap-2 py-1 pl-3">
              {/* The gutter marker, and the hollow dot. Same vocabulary the sidebar uses for a run
                  forked from another run — lineage reads the same way everywhere in the app. */}
              <span className="absolute left-[5px] top-[10px] h-px w-2 bg-hair" aria-hidden />
              <span
                className="z-10 mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full border border-hair bg-bg"
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <Truncate className="min-w-0 flex-1 text-[12px] text-muted" title={row.message}>
                    {row.message}
                  </Truncate>
                  <span className="shrink-0 text-[11px] text-faint">{relTime(row.at)}</span>
                </span>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block font-mono text-[11px] text-faint hover:underline"
                >
                  {row.sha.slice(0, 7)}
                  {row.author ? ` · @${row.author}` : ""} · not in Jaroku
                </a>
              </span>
            </div>
          ),
        )}
      </div>

      {/* The audit trail, when there is anything in it worth surfacing. A refusal and an override
          are the two rows somebody comes looking for later, so they are the two that are shown
          rather than the whole log. */}
      {view.events.some((e) => e.outcome !== "ok" || e.kind === "force_override") && (
        <div className="mt-2 space-y-0.5 border-t border-hair pt-2">
          {view.events
            .filter((e) => e.outcome !== "ok" || e.kind === "force_override")
            .slice(0, 5)
            .map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-[11px]">
                <span
                  className="mt-[2px] shrink-0"
                  style={{ color: e.kind === "force_override" ? STATUS.error : STATUS.pending }}
                  aria-hidden
                >
                  <XIcon size={10} />
                </span>
                <span className="min-w-0 flex-1 text-muted">
                  <span className="text-ink">{e.kind === "force_override" ? "overridden" : e.outcome}</span>{" "}
                  {e.detail}
                </span>
                <span className="shrink-0 text-faint">{relTime(e.created_at)}</span>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

// §6's file browser: what a version actually contains, out of the object store.
//
// NEVER OFF DISK, which §6 states as a requirement and the storage layer already enforces: "a replica
// that has never run this agent must show byte-identical output to the one that generated it".
// `runtime/agents/` is one namespace shared by every workspace on the box, so a browser that fell
// back to it would be showing whichever tenant happened to have materialised that slug.
//
// THE READ-ONLY REASON IS SHOWN, NOT JUST THE LOCK. §6 asks for "the stored reason", and three
// genuinely different things are being protected — the deploy artifacts that answer a public URL, the
// MCP grant and the reviewed bridge that honours it, and the audited connector templates. One
// "read-only" badge cannot say which, and a refusal nobody understands is one people work around.
//
// PLAIN MONO RATHER THAN THE SYNTAX HIGHLIGHTER. `CodeViewer` reads from `buildStore` — the CURRENT
// version, live-diagnosed, editable — and this is a read of an arbitrary PAST version out of the
// object store, which is a different subject with a different lifetime. Wiring the highlighter to
// both would mean one component switching between two sources of truth for what "the file" is, and
// the version that lost would be the one nobody was looking at. Reading a past version is what this
// is for; editing the current one is the Code overlay's job, and it is one Cmd+P away.

import { useEffect, useState } from "react";
import { Chip } from "./Chip.tsx";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { Truncate } from "./Truncate.tsx";
import { DownloadIcon } from "./agentIcons.tsx";
import { LockIcon } from "./panelIcons.tsx";
import { iconForPath } from "./fileIcons.tsx";
import { sendLoadAgentVersion } from "../lib/socket.ts";
import { downloadVersion } from "../lib/agentExport.ts";
import { fmtBytes } from "../lib/agentFormat.ts";
import { ACCENT, ICON } from "../lib/tokens.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";
import type { AgentDetailView, AgentFileView } from "../types.ts";

function FileRow({
  file,
  open,
  onToggle,
}: {
  file: AgentFileView;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = iconForPath(file.path);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-active/40"
      >
        <span className="shrink-0 text-faint" aria-hidden>
          <Icon size={ICON.xs} />
        </span>
        <Truncate variant="path" className="min-w-0 flex-1 font-mono text-[11px] text-ink">
          {file.path}
        </Truncate>
        {/* §6's per-file blame. Absent rather than guessed for a path no version recorded a change
            to — an imported project records no file stats at all, and claiming v1 would be an
            invention. */}
        {file.last_changed_in !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-faint" title={`Last changed in v${file.last_changed_in}`}>
            v{file.last_changed_in}
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-faint">{fmtBytes(file.bytes)}</span>
        {file.read_only && (
          <span
            className="shrink-0"
            style={{ color: ACCENT.reviewed }}
            // THE REASON, ON THE MARK. `read_only_reason` is a sentence the block list itself
            // supplies, so the tooltip cannot disagree with what the edit loop would actually do.
            title={file.read_only_reason ?? "read-only"}
            aria-label={file.read_only_reason ?? "read-only"}
          >
            <LockIcon size={ICON.xs} />
          </span>
        )}
      </button>
      {open && (
        <div className="mb-1 ml-2 rounded-control border border-hair bg-bg">
          {file.read_only && file.read_only_reason && (
            <div
              className="border-b border-hair px-2.5 py-1.5 text-[11px]"
              style={{ color: ACCENT.reviewed }}
            >
              {file.read_only_reason}
            </div>
          )}
          <pre className="max-h-[420px] overflow-auto px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-muted">
            {file.content}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AgentFiles({ detail }: { detail: AgentDetailView }) {
  const version = useAgentGridStore((s) => s.version);
  const loading = useAgentGridStore((s) => s.versionLoading);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const slug = detail.card.slug;
  const showing = version && version.agentId === slug ? version : null;

  // ASKED ON FIRST OPEN, NOT ON MOUNT. A version's files are the whole project's text — a few
  // kilobytes per file across a dozen files — and the detail's header, versions and tabs are all
  // useful without them. Fetching on open is what keeps §6's "always cheap to load" true of the part
  // that renders first.
  useEffect(() => {
    if (open && !showing && !loading) sendLoadAgentVersion(slug);
  }, [open, showing, loading, slug]);

  // A DIFFERENT AGENT CLOSES WHATEVER WAS EXPANDED. Leaving a file open would show one agent's
  // `agent.py` under another agent's name for as long as the next read took.
  useEffect(() => setExpanded(null), [slug, showing?.version]);

  /**
   * A VERSION ARRIVING IS SOMEBODY ASKING TO SEE FILES, so the region opens itself.
   *
   * The version history above has a `Files` button per row, and it could only fetch: the payload
   * landed in the store, this region was collapsed, and nothing whatever happened on screen. That is
   * the same class of failure as the card's Export — a control that appears to work and does not —
   * and the fix is the same shape, which is that the thing that CAN respond does.
   *
   * Only ever opens, never closes. Somebody who folded this away while a version was already showing
   * has said they do not want to look at it, and a later broadcast must not reopen it over them.
   */
  useEffect(() => {
    if (showing) setOpen(true);
  }, [showing?.agentId, showing?.version]);

  const files = showing?.files ?? [];

  return (
    <div className="border-b border-hair px-4 py-3">
      <CollapsibleRegion
        label={showing ? `Files · v${showing.version}` : "Files"}
        count={showing ? files.length : undefined}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        trailing={
          showing && files.length > 0 ? (
            <button
              type="button"
              // THE SHARED BUILDER, so this and the card's overflow entry produce the same document.
              // Two copies of it would drift the first time one grew a heading.
              onClick={() => downloadVersion(slug, showing.version, files)}
              title={`Export ${slug} v${showing.version} as markdown`}
              aria-label={`Export ${slug} v${showing.version}`}
              className="rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active hover:text-ink"
            >
              <DownloadIcon size={ICON.xs} />
            </button>
          ) : undefined
        }
      >
        {!showing ? (
          loading ? (
            // Skeleton rows at the row's own geometry — §9's no-spinner rule, and the list does not
            // jump when the real ones land.
            <div className="space-y-1 px-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-4 rounded bg-active/70" style={{ width: `${70 - i * 9}%` }} />
              ))}
            </div>
          ) : (
            <div className="px-2 py-1.5 text-[11px] text-faint">Nothing published for this agent yet.</div>
          )
        ) : files.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-faint">v{showing.version} contains no files.</div>
        ) : (
          <>
            {/* WHICH VERSION IS BEING BROWSED, always stated. The version history above can point
                this at any of them, and a file list that did not name its version would be one
                somebody reads as the current code. */}
            {showing.version !== detail.card.current_version && (
              <div className="mb-1.5 flex items-center gap-2 px-2 text-[11px] text-muted">
                <Chip size="sm" tone="faint">v{showing.version}</Chip>
                <span>is not the live version.</span>
                <button
                  onClick={() => sendLoadAgentVersion(slug, detail.card.current_version)}
                  className="text-muted underline decoration-dotted transition-colors hover:text-ink"
                >
                  Show v{detail.card.current_version}
                </button>
              </div>
            )}
            <div className="space-y-0.5">
              {files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  open={expanded === f.path}
                  onToggle={() => setExpanded((p) => (p === f.path ? null : f.path))}
                />
              ))}
            </div>
          </>
        )}
      </CollapsibleRegion>
    </div>
  );
}
